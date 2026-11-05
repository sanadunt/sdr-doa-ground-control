#!/bin/sh
# Builds the Groundstation tablet app (an APK) with the Android SDK's own tools:
# javac, aapt2, d8, zipalign and apksigner. No Gradle and no library besides
# the platform. Runs the plain-JVM tests of the discovery code first.
#
#   sh packaging/android-tablet/build.sh            # -> packaging/android-tablet/build/groundstation-tablet-<version>.apk
#
# Environment:
#   ANDROID_HOME   the Android SDK (default: Homebrew's android-commandlinetools)
#   JAVA_HOME      a JDK 17 or newer (default: Homebrew's openjdk@17)
#   KEYSTORE       the signing key (default: ~/.android/groundstation-tablet.keystore,
#                  made on first use; KEYSTORE.pass holds its password). An update
#                  installs over the previous APK only when both are signed with
#                  the same key, so keep this file.
set -eu

APP_VERSION_NAME=1.0.0
APP_VERSION_CODE=1
MIN_SDK=26
TARGET_SDK=34

HERE=$(cd "$(dirname "$0")" && pwd)
ANDROID_HOME=${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}
JAVA_HOME=${JAVA_HOME:-/opt/homebrew/opt/openjdk@17}
KEYSTORE=${KEYSTORE:-$HOME/.android/groundstation-tablet.keystore}
OUT="$HERE/build"

fail() {
    echo "build.sh: $*" >&2
    exit 1
}

[ -x "$JAVA_HOME/bin/javac" ] || fail "no JDK at $JAVA_HOME (set JAVA_HOME)"
PLATFORM="$ANDROID_HOME/platforms/android-$TARGET_SDK/android.jar"
[ -f "$PLATFORM" ] || fail "no android-$TARGET_SDK platform in $ANDROID_HOME (sdkmanager \"platforms;android-$TARGET_SDK\")"
BUILD_TOOLS=$(find "$ANDROID_HOME/build-tools" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort -V | tail -n 1)
[ -n "$BUILD_TOOLS" ] && [ -x "$BUILD_TOOLS/aapt2" ] || fail "no build-tools in $ANDROID_HOME (sdkmanager \"build-tools;35.0.0\")"

PATH="$JAVA_HOME/bin:$PATH"
export PATH JAVA_HOME

rm -rf "$OUT"
mkdir -p "$OUT/test-classes" "$OUT/classes" "$OUT/gen" "$OUT/dex"

echo "== tests"
# shellcheck disable=SC2046
javac -Xlint:all -Werror -d "$OUT/test-classes" \
    $(find "$HERE/java/com/sanadunt/groundview/core" "$HERE/test" -name '*.java')
java -ea -cp "$OUT/test-classes" com.sanadunt.groundview.core.CoreTest

echo "== resources"
"$BUILD_TOOLS/aapt2" compile --dir "$HERE/res" -o "$OUT/res.zip"
"$BUILD_TOOLS/aapt2" link -o "$OUT/unsigned.apk" \
    -I "$PLATFORM" \
    --manifest "$HERE/AndroidManifest.xml" \
    --java "$OUT/gen" \
    --min-sdk-version "$MIN_SDK" --target-sdk-version "$TARGET_SDK" \
    --version-code "$APP_VERSION_CODE" --version-name "$APP_VERSION_NAME" \
    "$OUT/res.zip"

echo "== code"
# Java 8 against the JDK's own Java 8 API (the platform jar's java.* stubs lack
# what lambdas compile to) and the platform's android.*; d8 desugars it.
# shellcheck disable=SC2046
javac --release 8 -classpath "$PLATFORM" -encoding UTF-8 \
    -d "$OUT/classes" \
    $(find "$HERE/java" "$OUT/gen" -name '*.java')
# shellcheck disable=SC2046
"$BUILD_TOOLS/d8" --release --min-api "$MIN_SDK" --lib "$PLATFORM" --output "$OUT/dex" \
    $(find "$OUT/classes" -name '*.class')
(cd "$OUT/dex" && zip -q -X "$OUT/unsigned.apk" classes.dex)

echo "== sign"
if [ ! -f "$KEYSTORE" ]; then
    mkdir -p "$(dirname "$KEYSTORE")"
    (
        umask 077
        LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32 >"$KEYSTORE.pass"
        keytool -genkeypair -keystore "$KEYSTORE" -storepass:file "$KEYSTORE.pass" \
            -alias groundstation -keyalg RSA -keysize 3072 -validity 10000 \
            -dname "CN=SDR-DoA Groundstation tablet" >/dev/null
    )
    echo "made a new signing key: $KEYSTORE (keep it, with $KEYSTORE.pass)"
fi
[ -f "$KEYSTORE.pass" ] || fail "no password file $KEYSTORE.pass next to the keystore"
APK="$OUT/groundstation-tablet-$APP_VERSION_NAME.apk"
"$BUILD_TOOLS/zipalign" -f -p 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"
"$BUILD_TOOLS/apksigner" sign --ks "$KEYSTORE" --ks-pass "file:$KEYSTORE.pass" \
    --ks-key-alias groundstation --out "$APK" "$OUT/aligned.apk"
"$BUILD_TOOLS/apksigner" verify "$APK"
rm -f "$OUT/unsigned.apk" "$OUT/aligned.apk" "$APK.idsig"
echo "== $APK"
