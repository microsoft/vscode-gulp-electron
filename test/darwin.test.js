"use strict";

var assert = require("assert");
var path = require("path");
var es = require("event-stream");
var File = require("vinyl");
var darwin = require("../src/darwin");

function runPatch(opts, inputFiles, cb) {
  var files = {};

  es.readArray(inputFiles)
    .pipe(darwin.patch(opts))
    .on("data", function (f) {
      files[f.relative] = f;
    })
    .on("error", cb)
    .on("end", function () {
      cb(null, files);
    });
}

function createFile(relativePath, contents) {
  return new File({
    cwd: process.cwd(),
    base: process.cwd(),
    path: path.join(process.cwd(), relativePath),
    contents: Buffer.from(contents, "utf8"),
  });
}

function createStreamFile(relativePath, contents) {
  var Readable = require("stream").Readable;
  var s = new Readable();
  s.push(contents);
  s.push(null);
  return new File({
    cwd: process.cwd(),
    base: process.cwd(),
    path: path.join(process.cwd(), relativePath),
    contents: s,
  });
}

function createDirectory(relativePath) {
  return new File({
    cwd: process.cwd(),
    base: process.cwd(),
    path: path.join(process.cwd(), relativePath),
    contents: null,
    stat: { isDirectory: function () { return true; } },
  });
}

var describeDarwin = process.platform === "darwin" ? describe : describe.skip;

describeDarwin("darwin patch", function () {
  it("should use separate assets options for app and miniapp", function (cb) {
    var mainAssetsPath = path.join(__dirname, "fixtures", "AssetsMain.car");
    var miniAssetsPath = path.join(__dirname, "fixtures", "AssetsMini.car");

    var mainTarget = path.join(
      "Electron.app",
      "Contents",
      "Resources",
      "Assets.car"
    );
    var miniTarget = path.join(
      "Electron.app",
      "Contents",
      "Applications",
      "Electron MiniApp.app",
      "Contents",
      "Resources",
      "Assets.car"
    );

    runPatch(
      {
        version: "35.0.0",
        productName: "Electron",
        productVersion: "1.0.0",
        darwinMiniAppName: "Electron MiniApp",
        darwinAssetsCar: mainAssetsPath,
        darwinMiniAppAssetsCar: miniAssetsPath,
      },
      [
        createFile(mainTarget, "old-main"),
        createFile(miniTarget, "old-mini"),
      ],
      function (err, files) {
        if (err) {
          return cb(err);
        }

        assert(files[mainTarget]);
        assert(files[miniTarget]);
        assert.equal(files[mainTarget].contents.toString("utf8"), "main-assets-car\n");
        assert.equal(files[miniTarget].contents.toString("utf8"), "mini-assets-car\n");
        cb();
      }
    );
  });

  it("should not patch miniapp assets when only darwinAssetsCar is provided", function (cb) {
    var mainAssetsPath = path.join(__dirname, "fixtures", "AssetsMain.car");

    var mainTarget = path.join(
      "Electron.app",
      "Contents",
      "Resources",
      "Assets.car"
    );
    var miniTarget = path.join(
      "Electron.app",
      "Contents",
      "Applications",
      "Electron MiniApp.app",
      "Contents",
      "Resources",
      "Assets.car"
    );

    runPatch(
      {
        version: "35.0.0",
        productName: "Electron",
        productVersion: "1.0.0",
        darwinMiniAppName: "Electron MiniApp",
        darwinAssetsCar: mainAssetsPath,
      },
      [
        createFile(mainTarget, "old-main"),
        createFile(miniTarget, "old-mini"),
      ],
      function (err, files) {
        if (err) {
          return cb(err);
        }

        assert(files[mainTarget]);
        assert(files[miniTarget]);
        assert.equal(files[mainTarget].contents.toString("utf8"), "main-assets-car\n");
        assert.equal(files[miniTarget].contents.toString("utf8"), "old-mini");
        cb();
      }
    );
  });

  it("should use darwinMiniAppDisplayName for the .app bundle name", function (cb) {
    var plist = require("plist");

    // The MiniApp's Info.plist lives under the original "Electron MiniApp.app" path
    var miniInfoPlist = path.join(
      "Electron.app",
      "Contents",
      "Applications",
      "Electron MiniApp.app",
      "Contents",
      "Info.plist"
    );

    var miniAppPlist = plist.build({
      CFBundleName: "Electron MiniApp",
      CFBundleDisplayName: "Electron MiniApp",
      CFBundleExecutable: "Electron MiniApp",
      CFBundleIdentifier: "com.electron.miniapp",
      CFBundleVersion: "1.0.0",
      CFBundleShortVersionString: "1.0.0",
      CFBundleIconName: "AppIcon",
    });

    // The executable inside MacOS uses the original name
    var miniExec = path.join(
      "Electron.app",
      "Contents",
      "Applications",
      "Electron MiniApp.app",
      "Contents",
      "MacOS",
      "Electron MiniApp"
    );

    var miniAppDir = path.join(
      "Electron.app",
      "Contents",
      "Applications",
      "Electron MiniApp.app"
    );

    runPatch(
      {
        version: "35.0.0",
        productName: "TestApp",
        productVersion: "1.0.0",
        darwinMiniAppName: "Agents - Insiders",
        darwinMiniAppDisplayName: "Visual Studio Code Agents - Insiders",
        darwinMiniAppBundleIdentifier: "com.test.agents",
      },
      [
        createStreamFile(miniInfoPlist, miniAppPlist),
        createFile(miniExec, "exec"),
        createDirectory(miniAppDir),
      ],
      function (err, files) {
        if (err) {
          return cb(err);
        }

        // The .app bundle should be renamed to the display name
        var renamedBundlePlist = path.join(
          "TestApp.app",
          "Contents",
          "Applications",
          "Visual Studio Code Agents - Insiders.app",
          "Contents",
          "Info.plist"
        );
        assert(files[renamedBundlePlist], "Bundle should use darwinMiniAppDisplayName for .app name");

        var shortNameBundlePlist = path.join(
          "TestApp.app",
          "Contents",
          "Applications",
          "Agents - Insiders.app",
          "Contents",
          "Info.plist"
        );
        assert(!files[shortNameBundlePlist], "Bundle must NOT use short name for .app directory");

        var infoPlist = plist.parse(files[renamedBundlePlist].contents.toString("utf8"));
        // CFBundleDisplayName should be the display name
        assert.equal(infoPlist["CFBundleDisplayName"], "Visual Studio Code Agents - Insiders");
        // CFBundleName should be the short name (used for executable)
        assert.equal(infoPlist["CFBundleName"], "Agents - Insiders");
        // CFBundleExecutable should be the short name
        assert.equal(infoPlist["CFBundleExecutable"], "Agents - Insiders");

        // The executable should be renamed to the short name, inside the display-name bundle
        var renamedExec = path.join(
          "TestApp.app",
          "Contents",
          "Applications",
          "Visual Studio Code Agents - Insiders.app",
          "Contents",
          "MacOS",
          "Agents - Insiders"
        );
        assert(files[renamedExec], "Executable should use darwinMiniAppName (short name)");

        var renamedAppDir = path.join(
          "TestApp.app",
          "Contents",
          "Applications",
          "Visual Studio Code Agents - Insiders.app"
        );
        assert(files[renamedAppDir], ".app directory should use darwinMiniAppDisplayName");

        var shortNameAppDir = path.join(
          "TestApp.app",
          "Contents",
          "Applications",
          "Agents - Insiders.app"
        );
        assert(!files[shortNameAppDir], ".app directory must NOT use short name");

        cb();
      }
    );
  });
});
