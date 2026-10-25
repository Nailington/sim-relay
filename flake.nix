{
  description = "Sim Relay — a desktop client for iOS simulators on another Mac";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      nixosModules.sim-relay-web = import ./nix/web-service.nix;
      nixosModules.default = self.nixosModules.sim-relay-web;

      overlays.default = final: _prev: {
        sim-relay = final.callPackage ./nix/package.nix { };
        sim-relay-web = final.callPackage ./nix/web-package.nix { };
      };

      packages = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        rec {
          sim-relay = pkgs.callPackage ./nix/package.nix { };
          sim-relay-web = pkgs.callPackage ./nix/web-package.nix { };
          default = sim-relay;
        }
      );

      apps = forAllSystems (system: {
        default = self.apps.${system}.sim-relay;
        sim-relay-web = {
          type = "app";
          program = "${self.packages.${system}.sim-relay-web}/bin/sim-relay-web";
          meta.description = "Serve Sim Relay browser workspaces";
        };
        sim-relay = {
          type = "app";
          program = "${self.packages.${system}.sim-relay}/bin/sim-relay";
          meta.description = "Open the Sim Relay desktop app";
        };
      });

      checks = forAllSystems (system: {
        inherit (self.packages.${system}) sim-relay sim-relay-web;
      });

      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt);

      devShells = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          # npm may have no path.txt when downloads are skipped, or retain the
          # platform-specific name from an earlier install. Support both forms.
          electronDist = pkgs.runCommand "sim-relay-electron-dev" { } ''
            mkdir -p "$out/Electron.app/Contents/MacOS"
            ln -s ${pkgs.lib.getExe pkgs.electron} "$out/electron"
            ln -s ${pkgs.lib.getExe pkgs.electron} "$out/Electron.app/Contents/MacOS/Electron"
          '';
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs_24
              pkgs.electron
              pkgs.nixfmt
            ];
            ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
            ELECTRON_OVERRIDE_DIST_PATH = "${electronDist}";
            # npm's native build tools need the compiler runtime on NixOS.
            LD_LIBRARY_PATH = pkgs.lib.optionalString pkgs.stdenv.hostPlatform.isLinux (
              pkgs.lib.makeLibraryPath [ pkgs.stdenv.cc.cc.lib ]
            );
          };
        }
      );
    };
}
