# BlitzMax LSP and Debug concept

This is a proof of concept VS Code debug adapter extension with integrated LSP support for BlitzMax.\
The debug adapter and LSP support is incomplete and will not work as intended nor represent the final product.

The debugger is a standard VS Code debug adapter.\
More information about how to develop a debug adapter can be found
[here](https://code.visualstudio.com/docs/extensions/example-debuggers).

You can also discuss this proof of concept on Discord: [![Discord Chat](https://img.shields.io/discord/613699895139762176.svg?logo=discord&style=social)](https://discord.gg/DrrVwhz)

### ***The extension does *not* include a LSP!***
---
This means you'll have to provide or write your own LSP.\
Here's a very quick and dirty [Example LSP](https://gist.github.com/Hezkore/a48373bbc19815655ca7d5938325524e) written in [BlitzMax NG](https://blitzmax.org/) to get your started.\
Use the [LSP inspector](https://microsoft.github.io/language-server-protocol/inspector/) and the sample.log to get a clearer picture on how this works.\
More VS Code LSP information can be found
[here](https://code.visualstudio.com/api/language-extensions/language-server-extension-guide), and the LSP specifications are found [here](https://microsoft.github.io/language-server-protocol/specifications/specification-current/).\
One thing to note when developing the LSP is that multiple instances of the same LSP may be used a the same time if the user is working with a multi-root workspace.

### ***The extension does *not* feature a task provider yet!***
---
This means it cannot build any BlitzMax source files *(`.bmx`)* or projects.\
Any BlitzMax source files *(`.bmx`)* must be compiled outside of VS Code or using a separate extension.

# Instructions
## Build and Run
* Make sure any previous BlitzMax VS Code extensions are disabled or uninstalled
* Make sure you have [Node.js](https://nodejs.org/) installed
* Clone [https://github.com/Hezkore/vscode-blitzmax-concept.git](https://github.com/Hezkore/vscode-blitzmax-concept.git) to any folder
* Open the folder in VS Code
* Type `npm install` in the terminal
* Press `F5` to build and launch in a new VS Code window

The extension will start when a BlitzMax source file *(`.bmx`)* is opened.

## LSP information
A LSP executable *(`lsp.exe` on Windows)* placed inside your `BlitzMaxNG\bin` folder will automatically run whenever the extension starts.\
Don't forget to set your BlitzMax path in settings first!\
You can restart the LSP with the command `Reload Window` in VS Code via the Command Palette *(`Ctrl+Shift+P`)*.

## Debugger information
The debugger currently only launches an existing already-built executable.
* In the new VS Code window
  * Open a folder or source file *(`.bmx`)* file
  * Make sure the opened source file *(`.bmx`)* has a `.debug` executable in the same folder\
  *(ie. `test.bmx` will need a `test.debug.exe` on Windows)*
  * Press `F5` and select `BlitzMax Debug` to start debugging the executable

Go [here](https://code.visualstudio.com/docs/editor/debugging#_run-view) to learn more about debugging in VS Code and how to *(not required)* setup a `launch.json` configuration.