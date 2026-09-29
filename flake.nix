{
  description = "Fetch my GitHub stars into SQLite and browse them on GitHub Pages";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAllSystems (pkgs: rec {
        # Static web app, without the database.
        site = pkgs.callPackage ./nix/site.nix { };

        fetch-stars = pkgs.writeShellApplication {
          name = "fetch-stars";
          runtimeInputs = [
            pkgs.gh
            pkgs.python3
          ];
          text = ''exec python3 ${./fetch_stars.py} "$@"'';
        };

        # assemble-site DB OUTDIR: static app + content-addressed copy of DB.
        assemble-site = pkgs.writeShellApplication {
          name = "assemble-site";
          runtimeInputs = [ pkgs.coreutils ];
          text = ''
            db=$1 out=$2
            mkdir -p "$out"
            cp -r --no-preserve=mode ${site}/. "$out/"
            hash=$(sha256sum "$db" | cut -c1-16)
            # Not gzip: the .gz extension (application/gzip) stops GitHub Pages from
            # compressing the file on the fly, which would break HTTP range requests.
            name="stars-$hash.sqlite.gz"
            cp "$db" "$out/$name"
            printf '{"url":"%s","size":%s}\n' "$name" "$(stat -c %s "$db")" > "$out/db.json"
            touch "$out/.nojekyll"
          '';
        };

        # serve-stars [DB] [PORT]: assemble into a temp dir and serve it with range support.
        serve-stars = pkgs.writeShellApplication {
          name = "serve-stars";
          runtimeInputs = [
            assemble-site
            pkgs.caddy
          ];
          text = ''
            db=''${1:-stars.sqlite} port=''${2:-8000}
            dir=$(mktemp -d)
            trap 'rm -rf "$dir"' EXIT
            assemble-site "$db" "$dir"
            echo "serving on http://localhost:$port"
            caddy file-server --root "$dir" --listen "localhost:$port"
          '';
        };

        default = site;
      });

      apps = forAllSystems (
        pkgs:
        let
          p = self.packages.${pkgs.stdenv.hostPlatform.system};
          app = drv: {
            type = "app";
            program = pkgs.lib.getExe drv;
          };
        in
        {
          fetch = app p.fetch-stars;
          assemble = app p.assemble-site;
          serve = app p.serve-stars;
          default = app p.serve-stars;
        }
      );

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.gh
            pkgs.python3
            pkgs.sqlite
            pkgs.caddy
            pkgs.nodejs
            pkgs.nixfmt
          ];
        };
      });

      formatter = forAllSystems (pkgs: pkgs.nixfmt-tree);
    };
}
