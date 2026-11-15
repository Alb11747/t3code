const { createRequire } = require("node:module");
const { readFileSync } = require("node:fs");
const path = require("node:path");

function replaceOnce(source, pattern, replacement, label) {
  const matches = [...source.matchAll(new RegExp(pattern.source, "g"))];
  if (matches.length !== 1) {
    throw new Error(`Fork Android signing: expected one ${label}, found ${matches.length}.`);
  }
  return source.replace(pattern, replacement);
}

function configureSigning(source) {
  const withConfig = replaceOnce(
    source,
    /    signingConfigs \{/,
    `    signingConfigs {
        forkRelease {
            storeFile file(System.getenv('T3CODE_ANDROID_KEYSTORE_PATH'))
            storePassword System.getenv('T3CODE_ANDROID_KEYSTORE_PASSWORD')
            keyAlias System.getenv('T3CODE_ANDROID_KEY_ALIAS')
            keyPassword System.getenv('T3CODE_ANDROID_KEY_PASSWORD')
        }`,
    "signingConfigs block",
  );
  // Only replace the release block's debug signing; debug builds keep their own key.
  return replaceOnce(
    withConfig,
    /(        release \{[\s\S]*?)signingConfig signingConfigs\.debug/,
    "$1signingConfig signingConfigs.forkRelease",
    "release debug-signing declaration",
  );
}

module.exports = function withForkAndroid(config) {
  const versionCode = Number(process.env.T3CODE_ANDROID_VERSION_CODE);
  if (!Number.isInteger(versionCode) || versionCode < 1 || versionCode > 2100000000) {
    throw new Error("T3CODE_ANDROID_VERSION_CODE must be a positive Android version code.");
  }
  config.name = "T3 Code Fork";
  config.version = `${config.version}-fork.${versionCode}`;
  config.scheme = "t3code-fork";
  config.android = { ...config.android, package: "com.alb11747.t3code", versionCode };
  // Upstream's Expo feed can replace the fork's embedded JavaScript.
  config.updates = { ...config.updates, enabled: false };
  config.extra = {
    ...config.extra,
    androidFork: true,
    androidForkUpdatePublicKey: readFileSync(path.join(__dirname, "update-public.pem"), "utf8"),
  };
  const mobileRequire = createRequire(path.resolve(__dirname, "../../apps/mobile/package.json"));
  const { withAppBuildGradle, withAndroidManifest } = mobileRequire("expo/config-plugins");
  config = withAndroidManifest(config, (next) => {
    const manifest = next.modResults.manifest;
    const application = manifest.application?.[0];
    if (!application) throw new Error("Fork Android updater requires a manifest application.");
    manifest["uses-permission"] ??= [];
    if (
      !manifest["uses-permission"].some(
        (item) => item.$["android:name"] === "android.permission.REQUEST_INSTALL_PACKAGES",
      )
    ) {
      manifest["uses-permission"].push({
        $: { "android:name": "android.permission.REQUEST_INSTALL_PACKAGES" },
      });
    }
    application.provider ??= [];
    const authority = "${applicationId}.forkupdates";
    if (!application.provider.some((item) => item.$["android:authorities"] === authority)) {
      application.provider.push({
        $: {
          "android:name": "androidx.core.content.FileProvider",
          "android:authorities": authority,
          "android:exported": "false",
          "android:grantUriPermissions": "true",
        },
        "meta-data": [
          {
            $: {
              "android:name": "android.support.FILE_PROVIDER_PATHS",
              "android:resource": "@xml/fork_update_paths",
            },
          },
        ],
      });
    }
    return next;
  });
  return withAppBuildGradle(config, (next) => {
    if (next.modResults.language !== "groovy") {
      throw new Error("Fork Android signing requires the Expo Groovy build.gradle template.");
    }
    next.modResults.contents = configureSigning(next.modResults.contents);
    return next;
  });
};

module.exports.configureSigning = configureSigning;
