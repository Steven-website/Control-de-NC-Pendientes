# Control de NC Pendientes

Aplicación web **estática** (publicable con **GitHub Pages**) para el control de
No Conformidades / Notas de Crédito pendientes. El usuario descarga una plantilla
en Excel, la trabaja, la sube y el sistema **consolida automáticamente** los datos
en formato **Parquet**, guardándolos en el repositorio de GitHub.

## ✨ Características

- 🔐 **Login con roles**: `master` (administrador) y `usuario`.
- 👥 **Control de usuarios**: el master crea, edita, activa/desactiva y elimina usuarios.
- 🔎 **Permiso por familia**: a cada usuario se le asignan **familias visibles**; solo verá
  (tablero, consolidado y exportaciones) las filas de **sus familias**. El master ve todo;
  un usuario sin familias asignadas también ve todo.
- 📥 **Descarga de plantilla** Excel con las columnas oficiales.
- 📤 **Carga de Excel** trabajado, con validación y **consolidación automática**.
- 🧩 **Reconciliación semanal** por clave (`NO_DOCU + NO_LINEA + PK_ARTICULOS`): al subir
  la base nueva, los registros que continúan **conservan sus estados** (Enviado/Aplicado),
  los nuevos entran como `Pendiente` y los que ya no aparecen pasan al **Histórico**.
- 🗄️ **Histórico**: respaldo automático de los registros que salieron de la base
  (`data/historico.parquet`). Si un registro reaparece en una carga, vuelve a la base vigente.
- 🗃️ **Almacenamiento en Parquet** dentro del repositorio (`data/consolidado.parquet`).
- 📊 **Tablero** con KPIs (pendientes/enviados CxP, costo total, documentos) y gráficos.
- ⬇️ **Exportación** del consolidado a **Excel** y **Parquet**.

## 🧮 Columnas

**Provenientes del SQL** (`SQL_CONTROL_DE_NC.xlsx`):

`TIPO DOC, FECHA_MOVIMIENTO, NO_DOCU, BODEGA_ORIGEN, CENTRO, ALMACEN, FAMILIA,
CATEGORIA, SUBCATEGORIA, NO_LINEA, COD_PROV, PROVEEDOR, PK_ARTICULOS, NO_ARTI,
DESCRIPCION, UNIDADES, COST_UNI, COST_TOTAL, OBSERV`

**Creadas por el sistema**:

| Columna | Tipo | Descripción |
|---|---|---|
| `ANTIGUEDAD` | calculada | `HOY − FECHA_MOVIMIENTO` en días. Se **recalcula en cada descarga**. |
| `ENVIADO_CXP` | lista | `Pendiente` / `Enviado`. |
| `FECHA_ENVIADO_CXP` | fecha | Fecha de envío a Cuentas por Pagar. |
| `APLICADO_CXP` | lista | `Pendiente` / `Aplicado`. |

## 🚀 Publicar en GitHub Pages

1. En GitHub: **Settings → Pages**.
2. *Source*: `Deploy from a branch`. Rama: `main` (o la que uses), carpeta `/ (root)`.
3. Abre la URL que genera GitHub Pages.

## 🔑 Acceso inicial

- Usuario: **master**
- Clave: **master123**

> Cambia esta clave desde **Usuarios** apenas ingreses.

## 💾 Guardar datos en GitHub (persistencia real)

Como es un sitio estático, **escribir** en el repo requiere un *token de acceso
personal* (PAT) con permiso de escritura. En la sección **Configuración** (solo
master) ingresa `owner`, `repo`, `rama` y `token`. El token se guarda **solo en
tu navegador** (`localStorage`), nunca se sube al repositorio.

Sin token, el sistema funciona en modo **local** (los datos quedan en el navegador
y se pueden exportar a Excel/Parquet).

> ⚠️ **Nota de seguridad**: al ser 100% estático, el login se valida en el
> navegador y no ofrece seguridad fuerte. Es adecuado para una herramienta
> interna; para seguridad real se requiere un backend.

## 🛠️ Tecnología

- HTML + CSS + JavaScript (sin framework, ES Modules).
- [SheetJS](https://sheetjs.com/) para Excel.
- [hyparquet](https://github.com/hyparam/hyparquet) + `hyparquet-writer` para Parquet.
- API de GitHub (Contents) para persistencia.

## 📁 Estructura

```
index.html          Interfaz (login + app)
css/styles.css      Estilos
js/schema.js        Definición de columnas (base, creadas, derivadas)
js/parquet.js       Lectura/escritura Parquet
js/github.js        Cliente de la API de GitHub
js/app.js           Lógica principal
data/usuarios.json  Usuarios (semilla con el master)
data/consolidado.parquet  Base consolidada vigente (se crea al guardar)
data/historico.parquet    Registros que salieron de la base (respaldo)
```

## 🔁 Flujo de actualización semanal

1. El **master** descarga/prepara la base (Excel con las columnas oficiales).
2. La sube en **Cargar / Plantilla** (un solo botón, sin opciones). El sistema la
   **reconcilia** con la base anterior:
   - Registros que **continúan** → conservan sus estados (Enviado/Aplicado + fechas).
   - Registros **nuevos** → entran como `Pendiente`.
   - Registros que **ya no aparecen** → se mueven al **Histórico** (no se borran).

> 💾 Para que la base y el histórico se compartan entre usuarios y persistan, el master
> debe configurar el **token de GitHub** en *Configuración*. Sin token, todo queda solo
> en el navegador del master.
