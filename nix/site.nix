{
  stdenvNoCC,
  fetchurl,
}:
let
  # Versions/hashes come from package-lock.json so Renovate can bump them.
  lock = builtins.fromJSON (builtins.readFile ../package-lock.json);
  npm =
    name:
    let
      pkg = lock.packages."node_modules/${name}";
    in
    fetchurl {
      url = pkg.resolved;
      hash = pkg.integrity;
    };
in
stdenvNoCC.mkDerivation {
  pname = "stars-site";
  version = "0.1.0";
  src = ../docs;
  dontBuild = true;
  installPhase = ''
    runHook preInstall
    mkdir -p $out/vendor
    cp -r . $out/
    unpack() { rm -rf "$TMPDIR/package" && tar xzf "$1" -C "$TMPDIR"; }
    unpack ${npm "sql.js-httpvfs"}
    cp $TMPDIR/package/dist/{index.js,sqlite.worker.js,sql-wasm.wasm} $out/vendor/
    unpack ${npm "marked"}
    cp $TMPDIR/package/lib/marked.umd.js $out/vendor/
    unpack ${npm "dompurify"}
    cp $TMPDIR/package/dist/purify.min.js $out/vendor/
    # Pages caches assets for 10 minutes: version them so a deploy never mixes old and new files.
    for f in app.js style.css; do
      v=$(sha256sum $out/$f | cut -c1-10)
      substituteInPlace $out/index.html --replace-fail "\"$f\"" "\"$f?v=$v\""
    done
    runHook postInstall
  '';
}
