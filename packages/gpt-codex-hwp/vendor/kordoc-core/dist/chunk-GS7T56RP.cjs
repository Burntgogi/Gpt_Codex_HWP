"use strict";Object.defineProperty(exports, "__esModule", {value: true});// node_modules/tsup/assets/cjs_shims.js
var getImportMetaUrl = () => typeof document === "undefined" ? new URL(`file:${__filename}`).href : document.currentScript && document.currentScript.tagName.toUpperCase() === "SCRIPT" ? document.currentScript.src : new URL("main.js", document.baseURI).href;
var importMetaUrl = /* @__PURE__ */ getImportMetaUrl();



exports.importMetaUrl = importMetaUrl;
//# sourceMappingURL=chunk-GS7T56RP.cjs.map