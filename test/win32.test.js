"use strict";

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var { Readable } = require("stream");
var Vinyl = require("vinyl");
var win32 = require("../src/win32");

function removeSignature(file, spawnSync) {
  return new Promise(function (resolve, reject) {
    win32._removeSignature(
      file,
      function (err, result) {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      },
      {
        getSignTool: function () {
          return "signtool.exe";
        },
        hasEmbeddedSignature: function () {
          return true;
        },
        spawnSync,
      }
    );
  });
}

(process.platform === "win32" ? describe : describe.skip)("win32", function () {
  for (const extension of ["exe", "dll"]) {
    it(`should remove signatures from .${extension} files`, async function () {
      const file = new Vinyl({
        path: `binary.${extension}`,
        contents: Buffer.from("signed"),
      });
      let tempPath;

      let callCount = 0;
      const result = await removeSignature(file, function (command, args, options) {
        assert.equal(command, "signtool.exe");
        assert.equal(options.encoding, "utf8");
        tempPath = args.at(-1);
        assert.equal(fs.readFileSync(tempPath, "utf8"), "signed");
        assert.equal(path.extname(tempPath), `.${extension}`);

        if (callCount++ === 0) {
          assert.deepEqual(args.slice(0, 4), ["verify", "/pa", "/all", "/v"]);
          return {
            status: 1,
            stdout: "Signature Index: 0 (Primary Signature)",
            stderr: "SignTool Error: A certificate chain terminated in an untrusted root.",
          };
        }

        assert.deepEqual(args.slice(0, 2), ["remove", "/s"]);
        fs.writeFileSync(tempPath, "unsigned");
        return { status: 0, stdout: "", stderr: "" };
      });

      assert.equal(result.contents.toString(), "unsigned");
      assert.equal(fs.existsSync(tempPath), false);
    });
  }

  it("should leave non-PE files unchanged", async function () {
    const file = new Vinyl({
      path: "resources.pak",
      contents: Buffer.from("contents"),
    });

    const result = await removeSignature(file, function () {
      assert.fail("SignTool should not run for non-PE files");
    });

    assert.strictEqual(result, file);
    assert.equal(result.contents.toString(), "contents");
  });

  it("should accept files without signatures", async function () {
    const file = new Vinyl({
      path: "unsigned.dll",
      contents: Readable.from(Buffer.from("unsigned")),
    });

    const result = await new Promise(function (resolve, reject) {
      win32._removeSignature(
        file,
        function (err, output) {
          if (err) {
            reject(err);
          } else {
            resolve(output);
          }
        },
        {
          getSignTool: function () {
            return "signtool.exe";
          },
          spawnSync: function (_command, args) {
            assert.deepEqual(args.slice(0, 4), ["verify", "/pa", "/all", "/v"]);
            return {
              status: 1,
              stdout: "",
              stderr: "SignTool Error: No signature found.",
            };
          },
        }
      );
    });

    assert.equal(result.contents.toString(), "unsigned");
  });

  it("should report SignTool failures and remove the temporary file", async function () {
    const file = new Vinyl({
      path: "broken.exe",
      contents: Buffer.from("signed"),
    });
    let tempPath;

    await assert.rejects(
      removeSignature(file, function (_command, args) {
        tempPath = args.at(-1);
        if (args[0] === "verify") {
          return {
            status: 0,
            stdout: "Signature Index: 0 (Primary Signature)",
            stderr: "",
          };
        }
        return {
          status: 1,
          stdout: "",
          stderr: "SignTool Error: Invalid file format.",
        };
      }),
      /Failed to remove code signature from broken\.exe: SignTool Error: Invalid file format\./
    );
    assert.equal(fs.existsSync(tempPath), false);
  });
});
