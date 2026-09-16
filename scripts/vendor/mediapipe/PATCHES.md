# Local patches to @mediapipe/tasks-vision 1.0.1

`vision_bundle.mjs` is the published bundle with one change.

The WebAssembly loader reads, writes and clears a global `self.Module`, following the Emscripten convention. Foundry VTT already defines a global `Module`, a deprecated alias for `foundry.packages.Module` that cannot be redefined. The loader treated Foundry's class as its own configuration and failed with "'caller', 'callee', and 'arguments' properties may not be accessed".

The loader now passes its own options to `ModuleFactory` and never reads or clears `self.Module`:

```diff
-return self.Module&&i&&((e=self.Module).locateFile=i.locateFile,i.mainScriptUrlOrBlob&&(e.mainScriptUrlOrBlob=i.mainScriptUrlOrBlob)),i=await self.ModuleFactory(self.Module||i),self.ModuleFactory=self.Module=void 0,new t(i,n)
+return i=await self.ModuleFactory(i),self.ModuleFactory=void 0,new t(i,n)
```

Re-apply this change when updating the bundle.
