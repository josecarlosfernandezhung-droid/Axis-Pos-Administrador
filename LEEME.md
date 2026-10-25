# Panel AxisPOS

Una sola app, dos versiones: **APK (Android)** y **.exe (Windows)**.

- La PC con MariaDB abre el programa de Windows. Ese programa lee la base y también sirve a los teléfonos por WiFi.
- El teléfono abre la APK, escribe la dirección que muestra la pantalla de la PC (ej. http://192.168.1.10:3000) y entra con su usuario de MariaDB.
- Usuario y contraseña de MariaDB se escriben al entrar; no se guardan en ningún archivo ni dentro de la APK.
- Solo lee datos (consultas SELECT), no modifica nada.

## Compilar en GitHub
1. Sube estos archivos al repositorio (la carpeta `.github/workflows/build.yml` debe existir).
2. Pestaña **Actions → Compilar app → Run workflow**.
3. Al terminar, abajo en *Artifacts* descargas `Panel-AxisPOS-android` (APK) y `Panel-AxisPOS-windows` (.exe).

## Notas
- Si Windows pregunta por el Firewall la primera vez, permite el acceso en redes privadas; sin eso el teléfono no puede conectarse.
- La base por defecto es `axispos_prueba` en `127.0.0.1:3306`; se cambia en «Opciones de conexión» al iniciar sesión.
