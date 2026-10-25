{
  lib,
  buildNpmPackage,
  nodejs_24,
  makeWrapper,
}:
buildNpmPackage {
  pname = "sim-relay-web";
  version = (lib.importJSON ../package.json).version;
  # An allowlist is intentional: private validation and runtime files never enter src.
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../package-lock.json
      ../tsconfig.json
      ../vite.config.ts
      ../index.html
      ../src
      ../scripts/build-web.mjs
      ../assets/app-icon.svg
      ../THIRD_PARTY_NOTICES.md
    ];
  };
  nodejs = nodejs_24;
  npmDepsHash = "sha256-zWUz0lO3pne1boBFBlw5MyY9eJIIzPP906FSla+EKTg=";
  ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
  nativeBuildInputs = [ makeWrapper ];
  buildPhase = ''
    runHook preBuild
    npm exec tsc --noEmit
    npm exec vite build
    node scripts/build-web.mjs
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    mkdir -p "$out/share/sim-relay-web" "$out/bin"
    cp -R dist-web/* "$out/share/sim-relay-web/"
    cp THIRD_PARTY_NOTICES.md "$out/share/sim-relay-web/"
    makeWrapper ${lib.getExe nodejs_24} "$out/bin/sim-relay-web" \
      --add-flags "$out/share/sim-relay-web/web.cjs"
    runHook postInstall
  '';
  meta = {
    description = "Authenticated browser workspaces for remote iOS simulators";
    license = lib.licenses.mit;
    mainProgram = "sim-relay-web";
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
  };
}
