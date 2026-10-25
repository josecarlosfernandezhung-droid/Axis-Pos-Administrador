const { app, BrowserWindow, dialog } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

if (!app.requestSingleInstanceLock()) app.quit();

async function crearVentana() {
  // Aquí se guardan la conexión y los PIN (carpeta privada del usuario de Windows)
  process.env.AX_DATA_DIR = app.getPath("userData");
  let puerto;
  try {
    const { iniciar } = await import(
      pathToFileURL(path.join(__dirname, "..", "server", "server.mjs")).href
    );
    puerto = await iniciar(3000);
  } catch (e) {
    dialog.showErrorBox(
      "Admin POS",
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
    title: "Admin POS",
    icon: path.join(__dirname, "..", "build", "icon.png"),
  });
  win.loadURL(`http://localhost:${puerto}`);
}

app.whenReady().then(crearVentana);
app.on("window-all-closed", () => app.quit());
