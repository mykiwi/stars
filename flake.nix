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
        scripts = pkgs.runCommand "stars-scripts" { } ''
          mkdir -p $out
          cp ${./fetch_stars.py} $out/fetch_stars.py
          cp ${./embed_stars.py} $out/embed_stars.py
          cp ${./star_history_svg.py} $out/star_history_svg.py
          cp ${./backfill_star_history.py} $out/backfill_star_history.py
        '';

        # Static web app, without the database.
        site = pkgs.callPackage ./nix/site.nix { };

        fetch-stars = pkgs.writeShellApplication {
          name = "fetch-stars";
          runtimeInputs = [
            pkgs.gh
            pkgs.python3
          ];
          text = ''exec python3 ${scripts}/fetch_stars.py "$@"'';
        };

        embed-stars = pkgs.writeShellApplication {
          name = "embed-stars";
          runtimeInputs = [
            (pkgs.python3.withPackages (ps: [
              ps.fastembed
              ps.sqlite-vec
            ]))
          ];
          text = ''exec python3 ${scripts}/embed_stars.py "$@"'';
        };

        backfill-history = pkgs.writeShellApplication {
          name = "backfill-history";
          runtimeInputs = [ pkgs.python3 ];
          text = ''exec python3 ${scripts}/backfill_star_history.py "$@"'';
        };

        # publish-backfill [LOCAL_DB]: merge a local backfill into the latest release DB and publish it.
        publish-backfill = pkgs.writeShellApplication {
          name = "publish-backfill";
          runtimeInputs = [
            backfill-history
            pkgs.gh
            pkgs.sqlite
            pkgs.coreutils
          ];
          text = ''
            local_db=''${1:-$HOME/.cache/stars-backfill/stars.sqlite}
            tmp=$(mktemp -d)
            trap 'rm -rf "$tmp"' EXIT
            tag=$(gh release list --limit 1 --json tagName --jq '.[0].tagName')
            gh release download "$tag" --pattern stars.sqlite --output "$tmp/stars.sqlite"
            sqlite3 "$local_db" ".backup '$tmp/local.sqlite'"
            backfill-history "$tmp/stars.sqlite" --merge-from "$tmp/local.sqlite" 2>&1 | tee "$tmp/log"
            count=$(sqlite3 "$tmp/stars.sqlite" "SELECT value FROM meta WHERE key = 'count'")
            gh release create "db-$(date -u +%Y%m%d-%H%M%S)" "$tmp/stars.sqlite" --latest \
              --title "$(date -u +%F) · $count stars (star history backfill)" \
              --notes "Star history from the local star-history.com backfill merged into $tag: $(tail -n 1 "$tmp/log")."
          '';
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
          embed = app p.embed-stars;
          backfill-history = app p.backfill-history;
          publish-backfill = app p.publish-backfill;
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
