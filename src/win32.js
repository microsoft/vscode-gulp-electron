"use strict";

var fs = require("fs");
var path = require("path");
var es = require("event-stream");
var rename = require("gulp-rename");
var temp = require("temp").track();
var rcedit = require("rcedit");
var semver = require("semver");
var { spawnSync } = require("child_process");

function getOriginalAppName(opts) {
  return semver.gte(opts.version, "0.24.0") ? "electron" : "atom";
}

function getOriginalAppFullName(opts) {
  return getOriginalAppName(opts) + ".exe";
}

function getSignTool() {
  let windowsSDKDir= "C:\\Program Files (x86)\\Windows Kits\\10\\bin\\";
  if (!fs.existsSync(windowsSDKDir)) {
    throw `There is no Windows 10 SDK installed at ${windowsSDKDir}.`;
  }

  let findSignTool = (start) => {
    let signToolPaths = [];
    fs.readdirSync(start).forEach(file => {
      const filename = path.join(start, file);
      const stat = fs.lstatSync(filename);
      if (stat.isDirectory()) {
        signToolPaths = signToolPaths.concat(findSignTool(filename));
      } else if (filename.endsWith("signtool.exe")) {
        signToolPaths.push(filename);
      }
    });
    return signToolPaths;
  }
  let signToolPaths = findSignTool(windowsSDKDir);
  let latestWindowsSDKVersion = signToolPaths.map(x => x.replace(windowsSDKDir, "").split("\\")[0]).pop();
  let latestWindowsSDKSignTools = signToolPaths.filter(x => x.startsWith(`${windowsSDKDir}${latestWindowsSDKVersion}`));
  let x64SignTool = latestWindowsSDKSignTools.find(x => x.includes("x64"));
  if (x64SignTool) {
    return x64SignTool;
  }
  let x86SignTool = latestWindowsSDKSignTools.find(x => x.includes("x86"));
  if (x86SignTool) {
    return x86SignTool;
  }
  throw `No supported version for signtool installed in ${windowsSDKDir}${latestWindowsSdkVersion}`;
}

exports.getAppPath = function (opts) {
  if (opts.productVersionString) {
    return path.join(opts.productVersionString, "resources", "app");
  }
  return path.join("resources", "app");
};

function patchExecutable(opts) {
  return es.map(function (f, cb) {
    if (
      f.relative !== getOriginalAppFullName(opts) ||
      process.platform !== "win32"
    ) {
      return cb(null, f);
    }

    var patch = {
      "version-string": {
        CompanyName: opts.companyName || "GitHub, Inc.",
        FileDescription: opts.productAppName || opts.productName,
        LegalCopyright:
          opts.copyright ||
          "Copyright (C) 2014 GitHub, Inc. All rights reserved",
        ProductName: opts.productAppName || opts.productName,
        ProductVersion: opts.productVersion,
      },
      "resource-string": {
        2: opts.productVersionString
      },
      "file-version": opts.productVersion,
      "product-version": opts.productVersion,
    };

    if (opts.winIcon) {
      patch.icon = opts.winIcon;
    }

    var tempPath = temp.path();
    var ostream = fs.createWriteStream(tempPath);

    f.contents.pipe(ostream);
    ostream.on("close", function () {
      // Remove codesignature before editing exe file
      const signToolPath = getSignTool();
      const {error} = spawnSync(signToolPath, ["remove", "/s", tempPath]);
      if (error) {
        return cb(error);
      }

      rcedit(tempPath, patch).then(() => {
        fs.readFile(tempPath, function (err, data) {
          if (err) {
            return cb(err);
          }

          f.contents = data;

          fs.unlink(tempPath, function (err) {
            if (err) {
              return cb(err);
            }

            cb(null, f);
          });
        });
      }).catch(err => {
        if (err) {
          return cb(err);
        }
      });
    });
  });
}

function removeDefaultApp() {
  var defaultAppPath = path.join("resources", "default_app");

  return es.mapSync(function (f) {
    if (!f.relative.startsWith(defaultAppPath)) {
      return f;
    }
  });
}

function renameApp(opts) {
  return rename(function (path) {
    if (
      path.dirname === "." &&
      path.basename === getOriginalAppName(opts) &&
      path.extname === ".exe"
    ) {
      path.basename = opts.productName;
    }
  });
}

function moveFilesExceptExecutable(opts) {
  const versionFolder = opts.productVersionString;
  if (!versionFolder) {
    throw new Error("productVersionString must be defined.");
  }
  return es.mapSync(function (f) {
    // Skip if the file is the renamed executable
    if (
      f.relative === `${opts.productName}.exe`
    ) {
      return f;
    }

    // Move other files to version subfolder
    if (f.path && f.base) {
      const relativePath = path.relative(f.base, f.path);
      f.path = path.join(f.base, versionFolder, relativePath);
    }

    return f;
  });
}

exports.patch = function (opts) {
  var pass = es.through();

  var src = pass
    .pipe(opts.keepDefaultApp ? es.through() : removeDefaultApp())
    .pipe(patchExecutable(opts))
    .pipe(renameApp(opts))
    .pipe(opts.createVersionedResources ? moveFilesExceptExecutable(opts) : es.through());

  return es.duplex(pass, src);
};
