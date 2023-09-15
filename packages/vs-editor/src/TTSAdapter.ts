import ExternalEditorApi, {
  CustomMessage,
  ErrorMessage,
  IncomingJsonObject,
  LoadingANewGame,
  ObjectCreated,
  OutgoingJsonObject,
  PrintDebugMessage,
  PushingNewObject,
} from "@matanlurey/tts-editor";
import { posix } from "path";
import { OutputChannel, Uri, window, workspace } from "vscode";

import configuration from "./configuration";
import { bundleLua, bundleXml, runTstl, unbundleLua } from "./io/bundle";
import { FileInfo, readWorkspaceFiles, writeWorkspaceFile } from "./io/files";

export class TTSAdapter {
  private api: ExternalEditorApi;
  private output: OutputChannel;

  /**
   * @param output Output channel where logs will be written to
   */
  public constructor(output: OutputChannel) {
    this.output = output;

    this.api = new ExternalEditorApi();
    this.initExternalEditorApi();
  }

  /**
   * Retrieves scripts from currently open game.
   */
  public getObjects = async () => {
    this.output.appendLine("Getting objects");
    this.api.getLuaScripts();
  };

  /**
   * Sends the bundled scripts to TTS
   */
  public saveAndPlay = async () => {
    try {
      await saveAllFiles();

      const outputPath = this.getOutputPath();
      const files = await readWorkspaceFiles(outputPath);
      const scripts = await this.createScripts(files, outputPath);
      this.api.saveAndPlay(scripts);
    } catch (e: any) {
      this.error(`${e}`);
    }
  };

  public executeCode = async (script: string) => {
    return this.api.executeLuaCode(script);
  };

  /**
   * Sends a custom structured object.
   *
   * @param object - Table to be sent to game
   */
  public async customMessage(object: any) {
    return this.api.customMessage(object);
  }

  private initExternalEditorApi = () => {
    this.api.on("loadingANewGame", this.onLoadGame.bind(this));
    this.api.on("pushingNewObject", this.onPushObject.bind(this));
    this.api.on("objectCreated", this.onObjectCreated.bind(this));
    this.api.on("printDebugMessage", this.onPrintDebugMessage.bind(this));
    this.api.on("errorMessage", this.onErrorMessage.bind(this));
    this.api.on("customMessage", this.onCustomMessage.bind(this));
    this.api.listen();
  };

  private onLoadGame = async (message: LoadingANewGame) => {
    this.info("recieved onLoadGame");
    this.readFilesFromTTS(message.scriptStates);
  };

  private onPushObject = async (message: PushingNewObject) => {
    this.info(`recieved onPushObject ${message.messageID}`);
    this.readFilesFromTTS(message.scriptStates);
  };

  private onObjectCreated = async (message: ObjectCreated) => {
    this.info(`recieved onObjectCreated ${message.guid}`);
  };

  private onPrintDebugMessage = async (message: PrintDebugMessage) => {
    this.info(message.message);
  };

  private onErrorMessage = async (message: ErrorMessage) => {
    this.error(message.error);
  };

  private onCustomMessage = async (message: CustomMessage) => {
    this.info(`recieved onCustomMessage ${message.customMessage}`);
  };

  private readFilesFromTTS = async (scriptStates: IncomingJsonObject[]) => {
    // TODO delete old files
    // TODO auto open files
    // TODO split raw files

    const outputPath = this.getOutputPath();
    const rawPath = Uri.joinPath(outputPath, "/raw");
    this.info(`Recieved ${scriptStates.length} scripts`);
    this.info(`Writing scripts to ${outputPath}`);

    scriptStates.map(toFileInfo).forEach((file) => {
      writeWorkspaceFile(outputPath, `${file.fileName}.lua`, file.script.content);
      writeWorkspaceFile(rawPath, `${file.fileName}.lua`, file.script.raw);

      if (file.ui) {
        writeWorkspaceFile(rawPath, `${file.fileName}.xml`, file.ui.raw);
        writeWorkspaceFile(outputPath, `${file.fileName}.xml`, file.ui.content);
      }
    });
  };

  private createScripts = async (files: FileInfo[], directory: Uri) => {
    const scripts = new Map<string, OutgoingJsonObject>();
    const includePaths = configuration.includePaths();

    this.info(`Using include paths ${includePaths}`);

    if (configuration.useTSTL()) {
      const path = this.getTSTLPath();
      this.info(`Running Typescript to Lua on ${path}`);
      const res = runTstl(path);
      this.info(JSON.stringify(res.diagnostics, null, 2));
    }

    for (const [fileName] of files) {
      const guid = fileName.split(".")[1];
      const fileUri = directory.with({
        path: posix.join(directory.path, fileName),
      });

      if (!scripts.has(guid)) {
        scripts.set(guid, { guid, script: "" });
      }

      try {
        if (fileName.endsWith(".lua")) {
          scripts.get(guid)!.script = await bundleLua(fileUri, includePaths);
        } else if (fileName.endsWith(".xml")) {
          scripts.get(guid)!.ui = await bundleXml(fileUri, includePaths[0]);
        }
      } catch (error: any) {
        window.showErrorMessage(error.message);
        console.error(error.stack);
      }
    }

    return Array.from(scripts.values());
  };

  private getWorkspaceRoot = (): Uri => {
    if (!workspace.workspaceFolders) {
      throw new Error("No workspace selected");
    }

    return workspace.workspaceFolders[0].uri;
  };

  private getOutputPath = (): Uri => {
    const root = this.getWorkspaceRoot();
    return Uri.joinPath(root, "/.tts");
  };

  private getTSTLPath = (): string => {
    const root = this.getWorkspaceRoot();
    const path = configuration.tstlPath();
    return Uri.joinPath(root, path).fsPath;
  };

  private info = (message: string) => {
    console.log(message);
    this.output.appendLine(message);
  };

  private error = (message: string) => {
    console.error(message);
    this.output.appendLine(message);
  };
}

interface ObjectFile {
  fileName: string;
  script: {
    raw: string;
    content: string;
  };
  ui?: {
    raw: string;
    content: string;
  };
}

const toFileInfo = (object: IncomingJsonObject): ObjectFile => {
  const baseName = object.name.replace(/([":<>/\\|?*])/g, "");
  const fileName = `${baseName}.${object.guid}`;

  return {
    fileName: fileName,
    script: {
      raw: object.script,
      content: getUnbundledLua(object.script),
    },
  };
};

const getUnbundledLua = (script: string) => {
  try {
    return unbundleLua(script);
  } catch (e) {
    console.error(e);
    return script;
  }
};

const saveAllFiles = async () => {
  try {
    await workspace.saveAll(false);
  } catch (reason: any) {
    throw new Error(`Unable to save opened files.\nDetail: ${reason}`);
  }
};
