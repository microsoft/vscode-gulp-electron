var assert = require("assert");
var path = require("path");
var download = require("../src/download");

function isBlockedByDnsProxy(err) {
  return Boolean(err && /Blocked by DNS monitoring proxy/.test(err.message));
}

function collectFirstMatchingFile(stream, matcher, cb) {
  var settled = false;
  var waitingForMatchContents = false;

  function done(err, file) {
    if (settled) {
      return;
    }

    settled = true;

    if (typeof stream.destroy === "function") {
      stream.destroy();
    }

    cb(err, file);
  }

  stream
    .on("data", function (f) {
      if (settled || !matcher(f)) {
        return;
      }

      if (Buffer.isBuffer(f.contents)) {
        return done(null, f);
      }

      waitingForMatchContents = true;
      var chunks = [];
      f.contents
        .on("data", function (chunk) {
          chunks.push(Buffer.from(chunk));
        })
        .on("error", done)
        .on("end", function () {
          waitingForMatchContents = false;
          f.contents = Buffer.concat(chunks);
          done(null, f);
        });
    })
    .on("error", function (err) {
      done(err);
    })
    .on("end", function () {
      if (waitingForMatchContents) {
        return;
      }

      done(null, null);
    });
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
    collectFirstMatchingFile(download({
      version: "35.0.0",
      platform: "darwin",
      token: process.env["GITHUB_TOKEN"],
    }), function (f) {
      return /libffmpeg\.dylib$/.test(f.relative);
    }, function (err, originalFile) {
      if (err) {
        return cb(err);
      }

      collectFirstMatchingFile(download({
          version: "35.0.0",
          platform: "darwin",
          token: process.env["GITHUB_TOKEN"],
          ffmpegChromium: true,
      }), function (f) {
        return /libffmpeg\.dylib$/.test(f.relative);
      }, function (err, modifiedFile) {
        if (err) {
          return cb(err);
        }

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
