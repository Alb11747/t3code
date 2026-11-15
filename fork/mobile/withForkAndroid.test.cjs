const assert = require("node:assert/strict");
const { test } = require("node:test");
const { configureSigning } = require("./withForkAndroid.cjs");

const TEMPLATE = `android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            // Generated Expo template signs release with the debug key.
            signingConfig signingConfigs.debug
            minifyEnabled true
        }
    }
}`;

test("release signing uses the persistent private key without changing debug signing", () => {
  const result = configureSigning(TEMPLATE);
  assert.match(result, /debug \{\s+signingConfig signingConfigs.debug/);
  assert.match(result, /release \{[^}]*signingConfig signingConfigs.forkRelease/);
  for (const field of ["KEYSTORE_PATH", "KEYSTORE_PASSWORD", "KEY_ALIAS", "KEY_PASSWORD"]) {
    assert.ok(result.includes(`System.getenv('T3CODE_ANDROID_${field}')`));
  }
});

test("template drift fails rather than leaving release signed with a debug key", () => {
  assert.throws(() => configureSigning("android {}"), /expected one signingConfigs block/);
  assert.throws(
    () => configureSigning(TEMPLATE.replace("release {", "production {")),
    /expected one release debug-signing declaration/,
  );
  assert.throws(() => configureSigning(TEMPLATE + TEMPLATE), /found 2/);
});
