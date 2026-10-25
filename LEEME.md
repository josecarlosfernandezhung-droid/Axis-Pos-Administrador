# Admin POS

Una sola app, dos versiones: **APK (Android)** y **Admin-POS.exe (Windows)**. Lee la base MariaDB de AxisPOS (solo lectura).

## Primera vez (en la PC de la tienda)
1. Abre Admin-POS.exe. Escribe **una sola vez** el usuario y la contraseña de MariaDB (usuario de solo lectura). Quedan guardados en esta PC y no se vuelven a pedir ni salen de ella.
2. Elige al administrador de AxisPOS y crea su PIN (4 a 8 números).
3. En **Ajustes** pon el PIN de cada usuario y su rol. Sin PIN no se entra.

## En el teléfono
Instala la APK, escribe la dirección que ves en la PC (ej. http://192.168.1.10:3000) y entra con tu PIN. La PC debe estar encendida y en el mismo WiFi.

## Roles
- **Administrador:** todo, incluido Ajustes (PIN, roles, conexión, umbrales).
- **Gerente:** todo menos Ajustes.
- **Cajero:** solo sus propias ventas, turnos y tickets; consulta precios y existencias (sin costos).
El rol sugerido sale del nivel del usuario en AxisPOS (3 = administrador, 2 = gerente, otro = cajero) y se puede cambiar.

## Secciones
Resumen (7/30/90 días/Todo, tiempo real, comparativos, ritmo del día, más vendido, familias, cajeros, últimos tickets) · Ventas (buscador, tickets, CSV) · Productos · Existencias por local · Caja (cierres: esperado vs contado, cobros) · Equipo (ventas por vendedor, devoluciones, socios) · Inventario (alertas, ABC, compras sugeridas) · Pérdidas (alertas de caja, mermas, eventos) · Ajustes.

## Compilar en GitHub
1. Sube todos los archivos al repositorio (debe existir `.github/workflows/build.yml`).
2. **Actions → Compilar Admin POS → Run workflow**.
3. Descarga en *Artifacts*: `Admin-POS-android` (APK) y `Admin-POS-windows` (Admin-POS.exe).

## Notas
- Si Windows pregunta por el Firewall, permite el acceso en redes privadas.
- ¿Olvidaste el PIN del administrador? En la PC, pantalla de PIN → «Olvidé el PIN del administrador» (pide la contraseña de MariaDB).
- Los datos de conexión y los PIN (cifrados con hash) se guardan en la carpeta privada de Windows del programa.
