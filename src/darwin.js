"use strict";

var path = require("path");
var plist = require("plist");
var es = require("event-stream");
var vfs = require("vinyl-fs");
var File = require("vinyl");
var rename = require("gulp-rename");
var semver = require("semver");

function getOriginalAppName(opts) {
  return semver.gte(opts.version, "0.24.0") ? "Electron" : "Atom";
}

function getOriginalMiniAppName(opts) {
  return getOriginalAppName(opts) + " MiniApp";
}

function getOriginalMiniAppFullName(opts) {
  return getOriginalMiniAppName(opts) + ".app";
}

function getMiniAppName(opts) {
  return opts.darwinMiniAppName || opts.productName + " MiniApp";
}

function getMiniAppFullName(opts) {
  return getMiniAppName(opts) + ".app";
}

function getOriginalAppFullName(opts) {
  return getOriginalAppName(opts) + ".app";
}

function getAppName(opts) {
  return (opts.productAppName || opts.productName) + ".app";
}

exports.getAppPath = function (opts) {
  return getAppName(opts) + "/Contents/Resources/app";
};

function removeDefaultApp(opts) {
  var defaultAppPath = path.join(
    getOriginalAppFullName(opts),
    "Contents",
    "Resources",
    "default_app"
  );

  return es.mapSync(function (f) {
    if (!f.relative.startsWith(defaultAppPath)) {
      return f;
    }
  });
}

function patchIcon(opts) {
  if (!opts.darwinIcon) {
    return es.through();
  }

  var resourcesPath = path.join(
    getOriginalAppFullName(opts),
    "Contents",
    "Resources"
  );
  var iconName = semver.gte(opts.version, "0.24.0")
    ? "electron.icns"
    : "atom.icns";
  var originalIconPath = path.join(resourcesPath, iconName);
  var iconPath = path.join(resourcesPath, opts.productName + ".icns");
  var pass = es.through();

  // filter out original icon
  var src = pass.pipe(
    es.mapSync(function (f) {
      if (f.relative !== originalIconPath) {
        return f;
      }
    })
  );

  // add custom icon
  var icon = vfs.src(opts.darwinIcon).pipe(rename(iconPath));

  return es.duplex(pass, es.merge(src, icon));
}

function patchInfoPlist(opts) {
  var contentsPath = path.join(getOriginalAppFullName(opts), "Contents");
  var resourcesPath = path.join(contentsPath, "Resources");
  var infoPlistPath = path.join(contentsPath, "Info.plist");
  var didCloseIcons = false;

  var icons = es.through();
  var input = es.through();
  var output = input.pipe(
    es.map(function (f, cb) {
      if (f.relative !== infoPlistPath) {
        return cb(null, f);
      }

      var contents = "";

      f.contents.on("error", function (err) {
        cb(err);
      });

      f.contents.on("data", function (d) {
        contents += d;
      });

      f.contents.on("end", function () {
        var infoPlist = plist.parse(contents.toString("utf8"));

        opts.darwinBundleIdentifier &&
          (infoPlist["CFBundleIdentifier"] = opts.darwinBundleIdentifier);
        opts.darwinApplicationCategoryType &&
          (infoPlist["LSApplicationCategoryType"] =
            opts.darwinApplicationCategoryType);
        infoPlist["CFBundleName"] = opts.productName;
        infoPlist["CFBundleDisplayName"] =
          opts.productDisplayName || opts.productName;
        infoPlist["CFBundleVersion"] = opts.productVersion;
        infoPlist["CFBundleShortVersionString"] = opts.productVersion;
        opts.copyright &&
          (infoPlist["NSHumanReadableCopyright"] = opts.copyright);
        infoPlist["CFBundleIconFile"] = opts.productName + ".icns";

        if (opts.darwinExecutable) {
          infoPlist["CFBundleExecutable"] = opts.darwinExecutable;
        }

        //Register the Application Help Book if it exists
        if (opts.darwinHelpBookFolder && opts.darwinHelpBookName) {
          infoPlist["CFBundleHelpBookFolder"] = opts.darwinHelpBookFolder;
          infoPlist["CFBundleHelpBookName"] = opts.darwinHelpBookName;
        }

        if (opts.darwinBundleDocumentTypes) {
          var iconsPaths = [];

          infoPlist["CFBundleDocumentTypes"] = (
            infoPlist["CFBundleDocumentTypes"] || []
          ).concat(
            opts.darwinBundleDocumentTypes.map(function (type) {
              iconsPaths.push(type.iconFile);

              var result = {
                CFBundleTypeName: type.name,
                CFBundleTypeRole: type.role,
                CFBundleTypeOSTypes: type.ostypes,
                CFBundleTypeExtensions: type.extensions,
                CFBundleTypeIconFile: path.basename(type.iconFile),
              };

              if (type.utis) {
                result["LSItemContentTypes"] = type.utis;
              }

              return result;
            })
          );

          if (iconsPaths.length) {
            didCloseIcons = true;
            es.merge(
              iconsPaths.map(function (iconPath) {
                return vfs.src(iconPath).pipe(
                  rename(function (path) {
                    path.dirname = resourcesPath;
                  })
                );
              })
            ).pipe(icons);
          }
        }

        if (opts.darwinBundleURLTypes) {
          infoPlist["CFBundleURLTypes"] = opts.darwinBundleURLTypes.map(
            function (type) {
              return {
                CFBundleTypeRole: type.role,
                CFBundleURLName: type.name,
                CFBundleURLSchemes: type.urlSchemes,
              };
            }
          );
        }

        if (opts.darwinForceDarkModeSupport) {
          infoPlist["NSRequiresAquaSystemAppearance"] = false;
        }

        f.contents = Buffer.from(plist.build(infoPlist), "utf8");
        cb(null, f);
      });
    }))
    .pipe(
      es.through(
        null,
        function () {
          if (!didCloseIcons) {
            es.readArray([]).pipe(icons);
          }

          this.emit("end");
        }
      )
    );

  return es.duplex(input, es.merge(output, icons));
}

function createEntitlementsPlist(opts) {
  var input = es.through();
  if (!opts.darwinEntitlements) {
    return input;
  }

  var contentsPath = path.join(getOriginalAppFullName(opts), "Contents");
  var entitlementsPlistPath = path.join(contentsPath, "Entitlements.plist");

  var result = {};
  opts.darwinEntitlements.forEach((element) => {
    result[element] = true;
  });

  var entitlementsFile = new File({
    path: entitlementsPlistPath,
    contents: Buffer.from(plist.build(result)),
  });

  return es.duplex(input, es.merge(input, es.readArray([entitlementsFile])));
}

function patchHelperInfoPlist(opts) {
  var didCloseIcons = false;

  var icons = es.through();
  var input = es.through();
  var output = input.pipe(
    es.map(function (f, cb) {
      const match = /Contents\/Frameworks\/Electron\ Helper( \(\w+\))?\.app\/Contents\/Info.plist$/i.exec(
        f.relative);
      if (!match) {
        return cb(null, f);
      }

      var contents = "";

      f.contents.on("error", function (err) {
        cb(err);
      });

      f.contents.on("data", function (d) {
        contents += d;
      });

      f.contents.on("end", function () {
        var infoPlist = plist.parse(contents.toString("utf8"));
        var suffix = match[1] ?? "";

        if (opts.darwinBundleIdentifier) {
          infoPlist["CFBundleIdentifier"] =
            opts.darwinBundleIdentifier + ".helper";
        }

        infoPlist["CFBundleName"] = `${opts.productName} Helper${suffix}`;

        if (infoPlist["CFBundleDisplayName"]) {
          infoPlist["CFBundleDisplayName"] = infoPlist["CFBundleName"];
        }

        if (infoPlist["CFBundleExecutable"]) {
          infoPlist["CFBundleExecutable"] = infoPlist["CFBundleName"];
        }

        f.contents = Buffer.from(plist.build(infoPlist), "utf8");
        cb(null, f);
      });
    }))
    .pipe(
      es.through(
        null,
        function () {
          if (!didCloseIcons) {
            es.readArray([]).pipe(icons);
          }

          this.emit("end");
        }
      )
    );

  return es.duplex(input, es.merge(output, icons));
}

function patchMiniAppInfoPlist(opts) {
  if (!opts.darwinMiniAppName) {
    return es.through();
  }

  var input = es.through();
  var output = input.pipe(
    es.map(function (f, cb) {
      // Match MiniApp's Info.plist at Contents/Applications/*/Contents/Info.plist
      const match = /Contents\/Applications\/[^\/]+\.app\/Contents\/Info.plist$/i.exec(
        f.relative);
      if (!match) {
        return cb(null, f);
      }

      var contents = "";

      f.contents.on("error", function (err) {
        cb(err);
      });

      f.contents.on("data", function (d) {
        contents += d;
      });

      f.contents.on("end", function () {
        var infoPlist = plist.parse(contents.toString("utf8"));

        var miniAppName = getMiniAppName(opts);

        // Bundle identifier
        if (opts.darwinMiniAppBundleIdentifier) {
          infoPlist["CFBundleIdentifier"] = opts.darwinMiniAppBundleIdentifier;
        } else if (opts.darwinBundleIdentifier) {
          infoPlist["CFBundleIdentifier"] = opts.darwinBundleIdentifier + ".miniapp";
        }

        // Name and display name
        infoPlist["CFBundleName"] = miniAppName;
        infoPlist["CFBundleDisplayName"] = opts.darwinMiniAppDisplayName || miniAppName;

        // Executable name
        infoPlist["CFBundleExecutable"] = miniAppName;

        // Version info
        infoPlist["CFBundleVersion"] = opts.productVersion;
        infoPlist["CFBundleShortVersionString"] = opts.productVersion;

        // Icon file
        if (opts.darwinMiniAppIcon) {
          infoPlist["CFBundleIconFile"] = path.basename(opts.darwinMiniAppIcon);
        }

        // Copyright
        if (opts.copyright) {
          infoPlist["NSHumanReadableCopyright"] = opts.copyright;
        }

        // URL types (protocol handlers)
        if (opts.darwinMiniAppBundleURLTypes) {
          infoPlist["CFBundleURLTypes"] = opts.darwinMiniAppBundleURLTypes.map(
            function (type) {
              return {
                CFBundleTypeRole: type.role,
                CFBundleURLName: type.name,
                CFBundleURLSchemes: type.urlSchemes,
              };
            }
          );
        }

        // Update host bundle reference
        if (opts.darwinBundleIdentifier) {
          infoPlist["ElectronHostBundleId"] = opts.darwinBundleIdentifier;
        }

        f.contents = Buffer.from(plist.build(infoPlist), "utf8");
        cb(null, f);
      });
    })
  );

  return es.duplex(input, output);
}

function patchMiniAppHelperInfoPlist(opts) {
  if (!opts.darwinMiniAppName) {
    return es.through();
  }

  var input = es.through();
  var output = input.pipe(
    es.map(function (f, cb) {
      // Match MiniApp Helper's Info.plist at Contents/Applications/*/Contents/Frameworks/Helper*.app/Contents/Info.plist
      const match = /Contents\/Applications\/[^\/]+\.app\/Contents\/Frameworks\/[^\/]+\ Helper( \(\w+\))?\.app\/Contents\/Info.plist$/i.exec(
        f.relative);
      if (!match) {
        return cb(null, f);
      }

      var contents = "";

      f.contents.on("error", function (err) {
        cb(err);
      });

      f.contents.on("data", function (d) {
        contents += d;
      });

      f.contents.on("end", function () {
        var infoPlist = plist.parse(contents.toString("utf8"));
        var suffix = match[1] ?? "";

        var miniAppName = getMiniAppName(opts);
        var helperName = miniAppName + " Helper" + suffix;

        // Bundle identifier
        if (opts.darwinMiniAppBundleIdentifier) {
          infoPlist["CFBundleIdentifier"] = opts.darwinMiniAppBundleIdentifier + ".helper";
        } else if (opts.darwinBundleIdentifier) {
          infoPlist["CFBundleIdentifier"] = opts.darwinBundleIdentifier + ".miniapp.helper";
        }

        infoPlist["CFBundleName"] = helperName;

        if (infoPlist["CFBundleDisplayName"]) {
          infoPlist["CFBundleDisplayName"] = helperName;
        }

        if (infoPlist["CFBundleExecutable"]) {
          infoPlist["CFBundleExecutable"] = helperName;
        }

        f.contents = Buffer.from(plist.build(infoPlist), "utf8");
        cb(null, f);
      });
    })
  );

  return es.duplex(input, output);
}

function patchMiniAppIcon(opts) {
  if (!opts.darwinMiniAppName || !opts.darwinMiniAppIcon) {
    return es.through();
  }

  var originalIconPath = path.join(
    getOriginalAppFullName(opts),
    "Contents",
    "Applications",
    getOriginalMiniAppFullName(opts),
    "Contents",
    "Resources",
    "miniapp.icns"
  );
  var iconPath = path.join(
    getOriginalAppFullName(opts),
    "Contents",
    "Applications",
    getOriginalMiniAppFullName(opts),
    "Contents",
    "Resources",
    path.basename(opts.darwinMiniAppIcon)
  );

  var pass = es.through();

  // filter out original icon
  var src = pass.pipe(
    es.mapSync(function (f) {
      if (f.relative !== originalIconPath) {
        return f;
      }
    })
  );

  // add custom icon
  var icon = vfs.src(opts.darwinMiniAppIcon).pipe(rename(iconPath));

  return es.duplex(pass, es.merge(src, icon));
}

function addCredits(opts) {
  if (!opts.darwinCredits) {
    return es.through();
  }

  var creditsPath = path.join(
    getOriginalAppFullName(opts),
    "Contents",
    "Resources",
    "Credits.rtf"
  );
  var input = es.through();
  var credits;

  if (typeof opts.darwinCredits === "string") {
    credits = vfs.src(opts.darwinCredits).pipe(rename(creditsPath));
  } else if (opts.darwinCredits instanceof Buffer) {
    credits = es.readArray([
      new File({
        path: creditsPath,
        contents: opts.darwinCredits,
      }),
    ]);
  } else {
    throw new Error("Unexpected value for darwinCredits");
  }

  return es.duplex(input, es.merge(input, credits));
}

function moveChromiumLicense(opts) {
  var newLicensePath = path.join(
    getOriginalAppFullName(opts),
    "Contents",
    "Resources"
  );
  return es.mapSync(function (f) {
    if (!f.isNull() && !f.isDirectory() && f.path === "LICENSES.chromium.html") {
      f.dirname = newLicensePath;
    }
    return f;
  });
}

function renameApp(opts) {
  var originalAppName = getOriginalAppName(opts);
  var originalAppNameRegexp = new RegExp("^" + getOriginalAppFullName(opts));
  var appName = getAppName(opts);

  return rename(function (path) {
    // The app folder itself looks like a file
    if (
      path.dirname === "." &&
      path.basename === originalAppName &&
      path.extname === ".app"
    ) {
      path.basename = opts.productAppName || opts.productName;
    } else {
      path.dirname = path.dirname.replace(originalAppNameRegexp, appName);
    }

    if (
      /Contents\/MacOS$/.test(path.dirname) &&
      path.basename === "Electron" &&
      opts.darwinExecutable
    ) {
      path.basename = opts.darwinExecutable;
    }
  });
}

function renameAppHelper(opts) {
  var originalAppName = getOriginalAppName(opts);
  var originalAppNameRegexp = new RegExp("^" + getOriginalAppFullName(opts));
  var appName = getAppName(opts);
  var name = opts.productName;

  return rename(function (path) {
    var basenameMatch = /^Electron Helper( \(\w+\))?$/.exec(path.basename);

    if (
      /Contents\/Frameworks/.test(path.dirname) &&
      path.extname === ".app" &&
      basenameMatch
    ) {
      var suffix = basenameMatch[1] || "";
      path.basename = name + " Helper" + suffix;
    } else if (
      /Contents\/Frameworks\/Electron\ Helper( \(\w+\))?\.app/.test(
        path.dirname
      )
    ) {
      var isInMacOS = /Contents\/Frameworks\/Electron\ Helper( \(\w+\))?\.app\/Contents\/MacOS$/.test(
        path.dirname
      );
      path.dirname = path.dirname.replace(
        /Electron\ Helper( \(\w+\))?\.app/,
        name + " Helper$1.app"
      );

      if (
        isInMacOS &&
        /^Electron Helper( \(\w+\))?$/.test(path.basename) &&
        path.extname === ""
      ) {
        path.basename = path.basename.replace(
          /Electron\ Helper( \(\w+\))?$/,
          name + " Helper$1"
        );
      }
    }
  });
}

function renameMiniApp(opts) {
  if (!opts.darwinMiniAppName) {
    return es.through();
  }

  var originalMiniAppName = getOriginalMiniAppName(opts);
  var originalMiniAppFullName = getOriginalMiniAppFullName(opts);
  var miniAppName = getMiniAppName(opts);
  var miniAppFullName = getMiniAppFullName(opts);

  return rename(function (path) {
    // Check if this is inside the Applications folder
    if (!/Contents\/Applications/.test(path.dirname) && 
        !(path.dirname === "." && path.basename === originalMiniAppName && /Contents\/Applications$/.test(path.dirname))) {
      // Not a miniapp path, but check if dirname contains Applications
      if (!path.dirname.includes("Contents/Applications")) {
        return;
      }
    }

    // Rename the MiniApp.app folder itself
    if (
      /Contents\/Applications$/.test(path.dirname) &&
      path.basename === originalMiniAppName &&
      path.extname === ".app"
    ) {
      path.basename = miniAppName;
      return;
    }

    // Rename paths inside MiniApp.app
    if (path.dirname.includes(originalMiniAppFullName)) {
      path.dirname = path.dirname.replace(
        originalMiniAppFullName,
        miniAppFullName
      );
    }

    // Rename the MiniApp executable in MacOS folder
    if (
      /Contents\/Applications\/[^\/]+\.app\/Contents\/MacOS$/.test(path.dirname) &&
      path.basename === originalMiniAppName &&
      path.extname === ""
    ) {
      path.basename = miniAppName;
    }
  });
}

function renameMiniAppHelper(opts) {
  if (!opts.darwinMiniAppName) {
    return es.through();
  }

  var originalMiniAppHelperName = getOriginalMiniAppName(opts) + " Helper";
  var miniAppName = getMiniAppName(opts);

  return rename(function (path) {
    // Only process paths inside MiniApp's Frameworks
    if (!/Contents\/Applications\/[^\/]+\.app\/Contents\/Frameworks/.test(path.dirname) &&
        !/Contents\/Applications\/[^\/]+\.app\/Contents\/Frameworks$/.test(path.dirname + "/" + path.basename)) {
      // Check if the path is the helper app folder itself
      if (!/Contents\/Applications/.test(path.dirname)) {
        return;
      }
    }
    
    // Rename the helper .app folder
    if (
      /Contents\/Applications\/[^\/]+\.app\/Contents\/Frameworks$/.test(path.dirname) &&
      path.extname === ".app"
    ) {
      var basenameMatch = /^Electron MiniApp Helper( \(\w+\))?$/.exec(path.basename);
      if (basenameMatch) {
        var suffix = basenameMatch[1] || "";
        path.basename = miniAppName + " Helper" + suffix;
        return;
      }
    }

    // Rename paths inside MiniApp Helper.app
    var helperDirMatch = /Electron\ MiniApp\ Helper( \(\w+\))?\.app/.exec(path.dirname);
    if (helperDirMatch) {
      var suffix = helperDirMatch[1] || "";
      path.dirname = path.dirname.replace(
        /Electron\ MiniApp\ Helper( \(\w+\))?\.app/,
        miniAppName + " Helper$1.app"
      );

      // Rename the helper executable
      var execMatch = /Contents\/Applications\/[^\/]+\.app\/Contents\/Frameworks\/[^\/]+\.app\/Contents\/MacOS$/.test(path.dirname);
      if (execMatch) {
        var execNameMatch = /^Electron MiniApp Helper( \(\w+\))?$/.exec(path.basename);
        if (execNameMatch && path.extname === "") {
          path.basename = miniAppName + " Helper" + (execNameMatch[1] || "");
        }
      }
    }
  });
}

exports.patch = function (opts) {
  var pass = es.through();

  var src = pass
    .pipe(opts.keepDefaultApp ? es.through() : removeDefaultApp(opts))
    .pipe(patchIcon(opts))
    .pipe(patchInfoPlist(opts))
    .pipe(patchHelperInfoPlist(opts))
    .pipe(patchMiniAppInfoPlist(opts))
    .pipe(patchMiniAppHelperInfoPlist(opts))
    .pipe(patchMiniAppIcon(opts))
    .pipe(createEntitlementsPlist(opts))
    .pipe(addCredits(opts))
    .pipe(moveChromiumLicense(opts))
    .pipe(renameApp(opts))
    .pipe(renameAppHelper(opts))
    .pipe(renameMiniApp(opts))
    .pipe(renameMiniAppHelper(opts));

  return es.duplex(pass, src);
};
