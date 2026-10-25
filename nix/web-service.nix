{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.sim-relay-web;
in
{
  options.services.sim-relay-web = {
    enable = lib.mkEnableOption "Sim Relay browser hosting";
    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.callPackage ./web-package.nix { };
      description = "Package providing sim-relay-web.";
    };
    runtimeConfigFile = lib.mkOption {
      type = lib.types.str;
      example = "/run/secrets/sim-relay-web.json";
      description = "Absolute path to a private runtime JSON file, supplied outside the Nix store. Contains users and optionally hosts, origin, bind, port, cert and key. Never use builtins.toFile or a Nix path literal for this file.";
    };
    tlsCertificateFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Absolute runtime certificate path, copied into systemd credentials for direct HTTPS.";
    };
    tlsKeyFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Absolute runtime private key path outside the Nix store, copied into systemd credentials.";
    };
    bind = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      description = "Listening address. Keep loopback when using a reverse proxy.";
    };
    port = lib.mkOption {
      type = lib.types.port;
      default = 49301;
      description = "Listening port.";
    };
    publicOrigin = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "https://sim-relay.example.com";
      description = "Public browser origin. Remote access requires HTTPS.";
    };
    allowedHosts = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [ "https://studio-mac.local:49300" ];
      description = "HTTPS Mac origins the relay may reach. Empty uses hosts from the runtime file.";
    };
  };
  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion =
          lib.hasPrefix "/" cfg.runtimeConfigFile && !(lib.hasPrefix "/nix/store/" cfg.runtimeConfigFile);
        message = "services.sim-relay-web.runtimeConfigFile must be an absolute runtime path outside /nix/store. Supply a string, never a Nix path literal.";
      }
      {
        assertion = (cfg.tlsCertificateFile == null) == (cfg.tlsKeyFile == null);
        message = "Set both services.sim-relay-web.tlsCertificateFile and tlsKeyFile.";
      }
      {
        assertion =
          lib.all (file: file == null || (lib.hasPrefix "/" file && !(lib.hasPrefix "/nix/store/" file)))
            [
              cfg.tlsCertificateFile
              cfg.tlsKeyFile
            ];
        message = "Sim Relay TLS files must be absolute runtime paths outside /nix/store.";
      }
    ];
    systemd.services.sim-relay-web = {
      description = "Sim Relay browser workspaces";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ];
      environment = {
        SIM_RELAY_WEB_BIND = cfg.bind;
        SIM_RELAY_WEB_PORT = toString cfg.port;
      }
      // lib.optionalAttrs (cfg.publicOrigin != null) {
        SIM_RELAY_WEB_ORIGIN = cfg.publicOrigin;
      }
      // lib.optionalAttrs (cfg.allowedHosts != [ ]) {
        SIM_RELAY_WEB_HOSTS = lib.concatStringsSep "," cfg.allowedHosts;
      };
      serviceConfig = {
        ExecStart = "${lib.getExe cfg.package} serve";
        LoadCredential = [
          "runtime.json:${cfg.runtimeConfigFile}"
        ]
        ++ lib.optionals (cfg.tlsCertificateFile != null && cfg.tlsKeyFile != null) [
          "tls-cert:${cfg.tlsCertificateFile}"
          "tls-key:${cfg.tlsKeyFile}"
        ];
        Environment = [
          "SIM_RELAY_WEB_CONFIG_FILE=%d/runtime.json"
        ]
        ++ lib.optionals (cfg.tlsCertificateFile != null && cfg.tlsKeyFile != null) [
          "SIM_RELAY_WEB_CERT=%d/tls-cert"
          "SIM_RELAY_WEB_KEY=%d/tls-key"
        ];
        DynamicUser = true;
        WorkingDirectory = "/";
        Restart = "on-failure";
        RestartSec = 5;
        TimeoutStopSec = 30;
        UMask = "0077";
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        PrivateDevices = true;
        RestrictAddressFamilies = [
          "AF_UNIX"
          "AF_INET"
          "AF_INET6"
        ];
      };
    };
  };
}
