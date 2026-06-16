var assert = require("assert");
var path = require("path");
var download = require("../src/download");

function isBlockedByDnsProxy(err) {
  return Boolean(err && /Blocked by DNS monitoring proxy/.test(err.message));
}

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
    var that = this;
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
      .on("error", function (err) {
        if (isBlockedByDnsProxy(err)) {
          return that.skip();
        }

        cb(err);
      })
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
    var finished = false;
    var ffmpegPathPattern = /libffmpeg\.dylib$/;

    function done(err) {
      if (finished) {
        return;
      }

      finished = true;
      cb(err);
    }

    var originalSize;
    var original = download({
      version: "35.0.0",
      platform: "darwin",
      token: process.env["GITHUB_TOKEN"],
    });

    original
      .on("data", function (f) {
        if (!ffmpegPathPattern.test(f.relative) || finished) {
          return;
        }

        originalSize = f.stat && f.stat.size;

        if (typeof original.destroy === "function") {
          original.destroy();
        }

        var modified = download({
          version: "35.0.0",
          platform: "darwin",
          token: process.env["GITHUB_TOKEN"],
          ffmpegChromium: true,
        });

        modified
          .on("data", function (f) {
            if (!ffmpegPathPattern.test(f.relative) || finished) {
              return;
            }

            if (typeof modified.destroy === "function") {
              modified.destroy();
            }

            try {
              assert(originalSize);
              assert(f.stat && f.stat.size);
              assert.notEqual(originalSize, f.stat.size);
            } catch (err) {
              return done(err);
            }

            done();
          })
          .on("error", done)
          .on("end", function () {
            if (!finished) {
              done(new Error("Modified ffmpeg file not found"));
            }
          });
      })
      .on("error", done)
      .on("end", function () {
        if (!finished && originalSize == null) {
          done(new Error("Original ffmpeg file not found"));
        }
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
