import * as clc from "cli-color";
import * as path from "path";
import * as refs from "./refs";
import { Config } from "../config";
import { InstanceSpec, ManifestInstanceSpec } from "../deploy/extensions/planner";
import { logger } from "../logger";
import { promptOnce } from "../prompt";
import { ParamBindingOptions, readEnvFile } from "./paramHelper";
import { FirebaseError } from "../error";
import * as utils from "../utils";
import { logPrefix } from "./extensionsHelper";
import { ParamType } from "./extensionsApi";

export const ENV_DIRECTORY = "extensions";

/**
 * Write a list of instanceSpecs to extensions manifest.
 *
 * The manifest is composed of both the extension instance list in firebase.json, and
 * env-var for each extension instance under ./extensions/*.env
 *
 * @param specs a list of InstanceSpec to write to the manifest
 * @param config existing config in firebase.json
 * @param options.nonInteractive will try to do the job without asking for user input.
 * @param options.force only when this flag is true this will overwrite existing .env files
 * @param allowOverwrite allows overwriting the entire manifest with the new specs
 */
export async function writeToManifest(
  specs: ManifestInstanceSpec[],
  config: Config,
  options: { nonInteractive: boolean; force: boolean },
  allowOverwrite: boolean = false
): Promise<void> {
  if (
    config.has("extensions") &&
    Object.keys(config.get("extensions")).length &&
    !options.nonInteractive &&
    !options.force
  ) {
    const currentExtensions = Object.entries(config.get("extensions"))
      .map((i) => `${i[0]}: ${i[1]}`)
      .join("\n\t");
    if (allowOverwrite) {
      const overwrite = await promptOnce({
        type: "list",
        message: `firebase.json already contains extensions:\n${currentExtensions}\nWould you like to overwrite or merge?`,
        choices: [
          { name: "Overwrite", value: true },
          { name: "Merge", value: false },
        ],
      });
      if (overwrite) {
        config.set("extensions", {});
      }
    }
  }

  writeExtensionsToFirebaseJson(specs, config);
  await writeEnvFiles(specs, config, options.force);
  await writeLocalSecrets(specs, config, options.force);
}

/**
 * Write the secrets in a list of ManifestInstanceSpec into extensions/{instance-id}.secret.local.
 *
 * Exported for testing.
 */
export async function writeLocalSecrets(
  specs: ManifestInstanceSpec[],
  config: Config,
  force?: boolean
): Promise<void> {
  for (const spec of specs) {
    if (!spec.paramSpecs) {
      continue;
    }

    const writeBuffer: Record<string, string> = {};
    const locallyOverridenSecretParams = spec.paramSpecs.filter(
      (p) => p.type === ParamType.SECRET && spec.params[p.param].local
    );
    for (const paramSpec of locallyOverridenSecretParams) {
      const key = paramSpec.param;
      const localValue = spec.params[key].local!;
      writeBuffer[key] = localValue;
    }

    const content = Object.entries(writeBuffer)
      .sort((a, b) => {
        return a[0].localeCompare(b[0]);
      })
      .map((r) => `${r[0]}=${r[1]}`)
      .join("\n");
    if (content) {
      await config.askWriteProjectFile(
        `extensions/${spec.instanceId}.secret.local`,
        content,
        force
      );
    }
  }
}

/**
 * Remove an instance from extensions manifest.
 */
export function removeFromManifest(instanceId: string, config: Config) {
  if (!instanceExists(instanceId, config)) {
    throw new FirebaseError(`Extension instance ${instanceId} not found in firebase.json.`);
  }

  const extensions = config.get("extensions", {});
  extensions[instanceId] = undefined;
  config.set("extensions", extensions);
  config.writeProjectFile("firebase.json", config.src);
  logger.info(`Removed extension instance ${instanceId} from firebase.json`);

  config.deleteProjectFile(`extensions/${instanceId}.env`);
  logger.info(`Removed extension instance environment config extensions/${instanceId}.env`);
  if (config.projectFileExists(`extensions/${instanceId}.env.local`)) {
    config.deleteProjectFile(`extensions/${instanceId}.env.local`);
    logger.info(
      `Removed extension instance local environment config extensions/${instanceId}.env.local`
    );
  }
  if (config.projectFileExists(`extensions/${instanceId}.secret.local`)) {
    config.deleteProjectFile(`extensions/${instanceId}.secret.local`);
    logger.info(
      `Removed extension instance local secret config extensions/${instanceId}.secret.local`
    );
  }
  // TODO(lihes): Remove all project specific env files.
}

export function loadConfig(options: any): Config {
  const existingConfig = Config.load(options, true);
  if (!existingConfig) {
    throw new FirebaseError(
      "Not currently in a Firebase directory. Run `firebase init` to create a Firebase directory."
    );
  }
  return existingConfig;
}

/**
 * Checks if an instance name already exists in the manifest.
 */
export function instanceExists(instanceId: string, config: Config): boolean {
  return !!config.get("extensions", {})[instanceId];
}

export function getInstanceRef(instanceId: string, config: Config): refs.Ref {
  if (!instanceExists(instanceId, config)) {
    throw new FirebaseError(`Could not find extension instance ${instanceId} in firebase.json`);
  }
  const ref = config.get("extensions", {})[instanceId];
  return refs.parse(ref);
}

function writeExtensionsToFirebaseJson(specs: ManifestInstanceSpec[], config: Config): void {
  const extensions = config.get("extensions", {});
  for (const s of specs) {
    extensions[s.instanceId] = refs.toExtensionVersionRef(s.ref!);
  }
  config.set("extensions", extensions);
  config.writeProjectFile("firebase.json", config.src);
  utils.logSuccess("Wrote extensions to " + clc.bold("firebase.json") + "...");
}

async function writeEnvFiles(
  specs: ManifestInstanceSpec[],
  config: Config,
  force?: boolean
): Promise<void> {
  for (const spec of specs) {
    const content = Object.entries(spec.params)
      .sort((a, b) => {
        return a[0].localeCompare(b[0]);
      })
      .map((r) => `${r[0]}=${r[1].baseValue}`)
      .join("\n");
    await config.askWriteProjectFile(`extensions/${spec.instanceId}.env`, content, force);
  }
}

/**
 * readParams gets the params for an extension instance from the `extensions` folder,
 * checking for project specific env files, then falling back to generic env files.
 * This checks the following locations & if a param is defined in multiple places, it prefers
 * whichever is higher on this list:
 *  - extensions/{instanceId}.env.local (only if checkLocal is true)
 *  - extensions/{instanceId}.env.{projectID}
 *  - extensions/{instanceId}.env.{projectNumber}
 *  - extensions/{instanceId}.env.{projectAlias}
 *  - extensions/{instanceId}.env
 */
export function readInstanceParam(args: {
  instanceId: string;
  projectDir: string;
  projectId?: string;
  projectNumber?: string;
  aliases?: string[];
  checkLocal?: boolean;
}): Record<string, string> {
  const aliases = args.aliases ?? [];
  const filesToCheck = [
    `${args.instanceId}.env`,
    ...aliases.map((alias) => `${args.instanceId}.env.${alias}`),
    ...(args.projectNumber ? [`${args.instanceId}.env.${args.projectNumber}`] : []),
    ...(args.projectId ? [`${args.instanceId}.env.${args.projectId}`] : []),
  ];
  if (args.checkLocal) {
    filesToCheck.push(`${args.instanceId}.env.local`);
  }
  let noFilesFound = true;
  const combinedParams = {};
  for (const fileToCheck of filesToCheck) {
    try {
      const params = readParamsFile(args.projectDir, fileToCheck);
      logger.debug(`Successfully read params from ${fileToCheck}`);
      noFilesFound = false;
      Object.assign(combinedParams, params);
    } catch (err: any) {
      logger.debug(`${err}`);
    }
  }
  if (noFilesFound) {
    throw new FirebaseError(`No params file found for ${args.instanceId}`);
  }
  return combinedParams;
}

function readParamsFile(projectDir: string, fileName: string): Record<string, string> {
  const paramPath = path.join(projectDir, ENV_DIRECTORY, fileName);
  const params = readEnvFile(paramPath);
  return params;
}

// TODO(lihes): Add a docs link once exists.
/**
 * Show deprecation warning about --local flag taking over current default bahaviors.
 */
export function showDeprecationWarning() {
  utils.logLabeledWarning(
    logPrefix,
    "The behavior of ext:install, ext:update, ext:configure, and ext:uninstall will change in firebase-tools@11.0.0. " +
      "Instead of deploying extensions directly, " +
      "changes to extension instances will be written to firebase.json and ./extensions/*.env. " +
      `Then ${clc.bold(
        "firebase deploy (--only extensions)"
      )} will deploy the changes to your Firebase project. ` +
      `To access this behavior now, pass the ${clc.bold("--local")} flag.`
  );
}

// TODO(lihes): Add a docs link once exists.
/**
 * Show preview warning about --local flag needing deploy to take effect in firebase project.
 */
export function showPreviewWarning() {
  utils.logLabeledWarning(
    logPrefix,
    "These changes will be reflected in your Firebase Emulator after restart. " +
      `Run ${clc.bold(
        "firebase deploy (--only extensions)"
      )} to deploy the changes to your Firebase project. `
  );
}
