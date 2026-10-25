const { app, BrowserWindow, dialog } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

if (!app.requestSingleInstanceLock()) app.quit();

async function crearVentana() {
  let puerto;
  try {
    const { iniciar } = await import(
      pathToFileURL(path.join(__dirname, "..", "server", "server.mjs")).href
    );
    puerto = await iniciar(3000);
  } catch (e) {
    dialog.showErrorBox(
      "Panel AxisPOS",
      e && e.code === "EADDRINUSE"
        ? "El puerto 3000 ya está en uso. Cierra otra copia del panel y vuelve a abrirlo."
        : String((e && e.message) || e)
    );
    app.quit();
    return;
  }
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    autoHideMenuBar: true,
    title: "Panel AxisPOS",
  });
  win.loadURL(`http://localhost:${puerto}`);
}

app.whenReady().then(crearVentana);
app.on("window-all-closed", () => app.quit());
