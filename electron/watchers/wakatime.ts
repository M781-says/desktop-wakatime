import { WindowInfo } from "@miniben90/x-win";
import { app, Notification, shell, Tray } from "electron";
import isDev from "electron-is-dev";
import { autoUpdater } from "electron-updater";

import type { Category, EntityType } from "../utils/types";
import type { AppData } from "../utils/validators";
import { AppsManager } from "../helpers/apps-manager";
import { ConfigFile } from "../helpers/config-file";
import { Dependencies } from "../helpers/dependencies";
import { MonitoringManager } from "../helpers/monitoring-manager";
import { PropertiesManager } from "../helpers/properties-manager";
import { SettingsManager } from "../helpers/settings-manager";
import { exec, getCLIPath, getDeepLinkUrl, getPlatfrom } from "../utils";
import { DeepLink } from "../utils/constants";
import { Logging, LogLevel } from "../utils/logging";

export class Wakatime {
  private lastEntitiy = "";
  private lastTime: number = 0;
  private lastCodeTimeFetched: number = 0;
  private lastCodeTimeText = "";
  private lastCategory: Category = "coding";
  private tray?: Tray | null;
  private versionString: string;
  private lastCheckedForUpdates: number = 0;

  constructor() {
    const version = `${getPlatfrom()}-wakatime/${app.getVersion()}`;
    this.versionString = version;
    process.on("uncaughtException", function (error, origin) {
      void Dependencies.reportError(error, origin, version);
      console.log(error);
    });
  }

  init(tray: Tray | null) {
    this.tray = tray;

    if (PropertiesManager.shouldLogToFile) {
      Logging.instance().activateLoggingToFile();
    }

    Logging.instance().log(`Starting WakaTime v${app.getVersion()}`);

    if (SettingsManager.shouldRegisterAsLogInItem()) {
      SettingsManager.registerAsLogInItem();
    }

    this.checkForUpdates();

    Dependencies.installDependencies();

    AppsManager.instance()
      .loadApps()
      .then((apps) => {
        if (!PropertiesManager.hasLaunchedBefore) {
          for (const app of apps) {
            if (app.isDefaultEnabled) {
              MonitoringManager.set(app, true);
            }
          }
          PropertiesManager.hasLaunchedBefore = true;
        }

        if (
          apps.find(
            (app) => app.isBrowser && MonitoringManager.isMonitored(app.path),
          )
        ) {
          (async () => {
            const browser = await Dependencies.recentBrowserExtension();
            if (browser && Notification.isSupported()) {
              const notification = new Notification({
                title: "Warning",
                subtitle: `WakaTime ${browser} extension detected. It’s recommended to only track browsing activity with the ${browser} extension or The Desktop app, but not both.`,
              });
              notification.show();
            }
          })();
        }
      });

    this.checkForApiKey();

    this.fetchToday();
  }

  checkForApiKey() {
    const key = ConfigFile.getSetting("settings", "api_key");
    if (!key) {
      this.openSettingsDeepLink();
    }
  }

  openSettingsDeepLink() {
    shell.openExternal(getDeepLinkUrl(DeepLink.settings));
  }

  private shouldSendHeartbeat(
    entity: string,
    time: number,
    isWrite: boolean,
    category: Category,
  ) {
    if (isWrite) {
      return true;
    }
    if (category !== this.lastCategory) {
      return true;
    }
    if (entity && this.lastEntitiy !== entity) {
      return true;
    }
    if (this.lastTime + 120 < time) {
      return true;
    }
  }

  async sendHeartbeat(props: {
    appData?: AppData;
    windowInfo: WindowInfo;
    entity: string;
    entityType: EntityType;
    category: Category | null;
    project: string | null;
    language: string | null;
    isWrite: boolean;
  }) {
    const {
      appData,
      entity,
      entityType,
      isWrite,
      language,
      project,
      windowInfo,
    } = props;
    const category = props.category ?? "coding";
    const time = Date.now() / 1000;

    if (!this.shouldSendHeartbeat(entity, time, isWrite, category)) {
      return;
    }
    if (!MonitoringManager.isMonitored(windowInfo.info.path)) {
      return;
    }

    const appName = windowInfo.info.name || appData?.name;
    if (!appName) {
      return;
    }

    this.lastEntitiy = entity;
    this.lastCategory = category;
    this.lastTime = time;

    const args: string[] = [
      "--entity",
      entity,
      "--entity-type",
      entityType,
      "--category",
      category,
      "--plugin",
      `${this.pluginString(appData, windowInfo)}`,
    ];

    if (project) {
      args.push("--project", project);
    }
    if (isWrite) {
      args.push("--write");
    }
    if (language) {
      args.push("--language", language);
    }

    const cli = getCLIPath();
    Logging.instance().log(`Sending heartbeat: ${cli} ${args}`);

    try {
      const [, err] = await exec(cli, ...args);
      if (err) {
        Logging.instance().log(
          `Error sending heartbeat: ${err}`,
          LogLevel.ERROR,
        );
      }
    } catch (error) {
      Logging.instance().log(`Failed to send heartbeat: ${error}`);
    }

    await this.fetchToday();
    this.checkForUpdates();
  }

  public async fetchToday() {
    if (!PropertiesManager.showCodeTimeInStatusBar) {
      // tray.setTitle is only available on darwin/macOS
      this.tray?.setTitle("");
      this.tray?.setToolTip("Wakatime");
      return;
    }

    const time = Date.now() / 1000;
    if (this.lastCodeTimeFetched + 120 > time) {
      this.tray?.setTitle(` ${this.lastCodeTimeText}`);
      this.tray?.setToolTip(` ${this.lastCodeTimeText}`);
      return;
    }

    this.lastCodeTimeFetched = time;

    const args: string[] = [
      "--today",
      "--today-hide-categories",
      "true",
      "--plugin",
      `${this.pluginString()}`,
    ];

    const cli = getCLIPath();
    Logging.instance().log(`Fetching code time: ${cli} ${args}`);

    try {
      const [output, err] = await exec(cli, ...args);
      if (err) {
        Logging.instance().log(
          `Error fetching code time: ${err}`,
          LogLevel.ERROR,
        );
        return;
      }
      this.lastCodeTimeText = output;
      this.tray?.setTitle(` ${output}`);
      this.tray?.setToolTip(` ${output}`);
    } catch (error) {
      Logging.instance().log(
        `Failed to fetch code time: ${error}`,
        LogLevel.ERROR,
      );
    }
  }

  public async checkForUpdates() {
    if (!PropertiesManager.autoUpdateEnabled || isDev) return;
    if (this.lastCheckedForUpdates + 600 * 1000 > Date.now()) return;

    autoUpdater.checkForUpdatesAndNotify();
  }

  pluginString(appData?: AppData, windowInfo?: WindowInfo) {
    const appName = windowInfo?.info.name || appData?.name;
    if (!appName) {
      return this.versionString;
    }

    const appNameSafe = appName.replace(/\s/g, "");
    const appVersion = appData?.version?.replace(/\s/g, "") || "unknown";

    return `${appNameSafe}/${appVersion} ${this.versionString}`;
  }
}
