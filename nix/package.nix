{
  lib,
  stdenv,
  buildNpmPackage,
  nodejs_24,
  electron,
  makeWrapper,
  makeDesktopItem,
  copyDesktopItems,
  autoPatchelfHook,
  python3,
}:

assert lib.assertMsg (lib.versionAtLeast electron.version "43")
  "Sim Relay needs Electron 43 or newer (asynchronous safeStorage APIs).";
buildNpmPackage {
  pname = "sim-relay";
  version = (lib.importJSON ../package.json).version;

  # Only build inputs enter the store; exclude local installers, profiles and dependencies.
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../package-lock.json
      ../tsconfig.json
      ../vite.config.ts
      ../index.html
      ../src
      ../scripts/build.mjs
      ../assets/app-icon.svg
      ../THIRD_PARTY_NOTICES.md
    ];
  };

  nodejs = nodejs_24;
  npmDepsHash = "sha256-1M2d2rGMDDpGOmIWO8BVlDSLid//fjiXiV5LI96RXpI=";
  ELECTRON_SKIP_BINARY_DOWNLOAD = "1";

  nativeBuildInputs = [
    makeWrapper
  ]
  ++ lib.optionals stdenv.hostPlatform.isLinux [
    copyDesktopItems
    autoPatchelfHook
  ]
  ++ lib.optionals stdenv.hostPlatform.isDarwin [ python3 ];
  buildInputs = lib.optionals stdenv.hostPlatform.isLinux [ stdenv.cc.cc.lib ];

  preBuild = lib.optionalString stdenv.hostPlatform.isLinux ''
    # resvg is a native build-time dependency; fix its loader before rendering the icon.
    autoPatchelf node_modules/@resvg node_modules/@rollup
  '';

  installPhase = ''
    runHook preInstall
    npm prune --omit=dev --ignore-scripts
    appDir="$out/share/sim-relay"
    mkdir -p "$appDir/assets" "$appDir/src/host" "$out/bin"
    cp -R dist dist-electron dist-host node_modules package.json THIRD_PARTY_NOTICES.md "$appDir/"
    cp assets/app-icon.png "$appDir/assets/"
    cp src/host/idb.proto "$appDir/src/host/"
  ''
  + lib.optionalString stdenv.hostPlatform.isLinux ''
    makeWrapper ${lib.getExe electron} "$out/bin/sim-relay" \
      --add-flags "$appDir" \
      --add-flags '--ozone-platform-hint=auto'
    install -Dm644 assets/app-icon.png \
      "$out/share/icons/hicolor/1024x1024/apps/dev.simrelay.png"
  ''
  + lib.optionalString stdenv.hostPlatform.isDarwin ''
    mkdir -p "$out/Applications"
    cp -R ${electron}/Applications/Electron.app "$out/Applications/Sim Relay.app"
    bundle="$out/Applications/Sim Relay.app/Contents"
    chmod -R u+w "$out/Applications/Sim Relay.app"
    rm -f "$bundle/Resources/default_app.asar"
    ln -s "$appDir" "$bundle/Resources/app"
    python3 - "$bundle/Info.plist" <<'PY'
    import plistlib
    import sys
    with open(sys.argv[1], 'rb') as f:
        info = plistlib.load(f)
    info.update({
        'CFBundleName': 'Sim Relay',
        'CFBundleDisplayName': 'Sim Relay',
        'CFBundleIdentifier': 'dev.simrelay.desktop',
        'NSLocalNetworkUsageDescription': 'Sim Relay connects to iOS simulators on your network.',
        'NSBonjourServices': ['_simrelay._tcp'],
    })
    with open(sys.argv[1], 'wb') as f:
        plistlib.dump(info, f)
    PY
    makeWrapper "$bundle/MacOS/Electron" "$out/bin/sim-relay"
  ''
  + ''
    makeWrapper ${lib.getExe nodejs_24} "$out/bin/sim-relay-host" \
      --add-flags "$appDir/dist-host/host.cjs" \
      --prefix PATH : /usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin
    runHook postInstall
  '';

  desktopItems = lib.optionals stdenv.hostPlatform.isLinux [
    (makeDesktopItem {
      name = "dev.simrelay";
      desktopName = "Sim Relay";
      comment = "Use iOS simulators on another Mac";
      exec = "sim-relay";
      icon = "dev.simrelay";
      categories = [ "Development" ];
      terminal = false;
      startupWMClass = "ios-sim-stream";
    })
  ];

  meta = {
    description = "Desktop client for iOS simulators running on another Mac";
    license = lib.licenses.mit;
    mainProgram = "sim-relay";
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
      "aarch64-darwin"
    ];
  };
}
