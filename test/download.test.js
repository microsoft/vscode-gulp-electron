var assert = require("assert");
var path = require("path");
var filter = require("gulp-filter");
var buffer = require("gulp-buffer");
var es = require("event-stream");
var download = require("../src/download");

describe("download", function () {
  this.timeout(1000 * 60 * 5);

  it("should work", function (cb) {
    var didSeeInfoPList = false;

    download({
      version: "35.0.0",
      platform: "darwin",
      token: process.env["GITHUB_TOKEN"],
    })
      .on("data", function (f) {
        if (
          f.relative === path.join("Electron.app", "Contents", "Info.plist")
        ) {
          didSeeInfoPList = true;
        }
      })
      .on("error", cb)
      .on("end", function () {
        assert(didSeeInfoPList);
        cb();
      });
  });

  it.skip("should download with custom tag", function (cb) {
    var didSeeInfoPList = false;

    download({
      version: "22.3.6",
      tag: "v22.3.6-20472245",
      repo: "microsoft/vscode-gulp-electron",
      platform: "darwin",
      token: process.env["GITHUB_TOKEN"],
    })
      .on("data", function (f) {
        if (
          f.relative === path.join("Electron.app", "Contents", "Info.plist")
        ) {
          didSeeInfoPList = true;
        }
      })
      .on("error", cb)
      .on("end", function () {
        assert(didSeeInfoPList);
        cb();
      });
  });

  it("should download from a custom repo", function (cb) {
    var didSeeInfoPList = false;

    download({
      version: "32.2.3",
      repo: "deepak1556/electron-debug-version",
      platform: "darwin",
      arch: "arm64",
      token: process.env["GITHUB_TOKEN"],
    })
      .on("data", function (f) {
        if (
          f.relative === path.join("Electron.app", "Contents", "Info.plist")
        ) {
          didSeeInfoPList = true;
        }
      })
      .on("error", cb)
      .on("end", function () {
        assert(didSeeInfoPList);
        cb();
      });
  });

  it("should download PDBs", function (cb) {
    var didSeePDBs = false;

    download({
      version: "36.0.0",
      platform: "win32",
      arch: "x64",
      pdbs: true,
      token: process.env["GITHUB_TOKEN"],
    })
      .on("data", function (f) {
        if (
          /ffmpeg.dll.pdb/.test(
            f.relative
          )
        ) {
          didSeePDBs = true;
        }
      })
      .on("error", cb)
      .on("end", function () {
        assert(didSeePDBs);
        cb();
      });
  });

  it("should download symbols", function (cb) {
    var didSeeSymbols = false;

    download({
      version: "35.0.0",
      platform: "win32",
      symbols: true,
      token: process.env["GITHUB_TOKEN"],
    })
      .on("data", function (f) {
        if (
          /breakpad_symbols[\\\/]electron.exe.pdb[\\\/][A-Ea-e0-9]+[\\\/]electron.exe.sym/.test(
            f.relative
          )
        ) {
          didSeeSymbols = true;
        }
      })
      .on("error", cb)
      .on("end", function () {
        assert(didSeeSymbols);
        cb();
      });
  });

  it("should replace ffmpeg", function (cb) {
    var ffmpegSeen = false;

    var originalFile = null;
    var original = download({
      version: "35.0.0",
      platform: "darwin",
      token: process.env["GITHUB_TOKEN"],
    })
      .pipe(filter("**/libffmpeg.dylib"))
      .pipe(buffer())
      .pipe(
        es.through(function (f) {
          originalFile = f;
        })
      )
      .on("end", function () {
        var modifiedFile = null;
        var modified = download({
          version: "35.0.0",
          platform: "darwin",
          token: process.env["GITHUB_TOKEN"],
          ffmpegChromium: true,
        })
          .pipe(filter("**/libffmpeg.dylib"))
          .pipe(buffer())
          .pipe(
            es.through(function (f) {
              modifiedFile = f;
            })
          )
          .on("end", function () {
            assert(originalFile);
            assert(modifiedFile);
            assert(
              originalFile.contents.length !== modifiedFile.contents.length
            );
            cb();
          });
      });
  });

  it("should error properly", function (cb) {
    download({
      version: "35.0.0",
      platform: "darwin",
      token: process.env["GITHUB_TOKEN"],
      repo: "foo",
    })
      .once("data", function () {
        cb(new Error("Should never be here"));
      })
      .once("error", function () {
        cb();
      });
  });

  it("should error when checksum file does not contain the expected value", function (cb) {
    download({
      version: "22.3.11",
      platform: "darwin",
      token: process.env["GITHUB_TOKEN"],
      validateChecksum: true,
      checksumFile: path.join(__dirname, "fixtures", "SHASUMS256-BAD.txt"),
    })
      .once("data", function () {
        cb(new Error("Should never be here"));
      })
      .once("error", function () {
        cb();
      });
  });

  it("should pass checksum validation", function (cb) {
    download({
      version: "22.3.11",
      token: process.env["GITHUB_TOKEN"],
      platform: "darwin",
      validateChecksum: true,
      checksumFile: path.join(__dirname, "fixtures", "SHASUMS256-GOOD.txt"),
    })
      .on("data", function (f) {
        if (
          f.relative === path.join("Electron.app", "Contents", "Info.plist")
        ) {
          didSeeInfoPList = true;
        }
      })
      .on("error", cb)
      .on("end", function () {
        assert(didSeeInfoPList);
        cb();
      });
  });
});
