# NLPmanager — Setup & Run

## Prerequisites

- Node.js 18+
- PostgreSQL 14+ (running locally)
- MedScan installation directory with cartridge .bin folders

## Install

```bash
cd C:\NLPmanager\app
npm install
```

## First-time database setup

1. Create a PostgreSQL database named `nlpmanager` (or your preferred name):
   ```sql
   CREATE DATABASE nlpmanager;
   ```

2. Launch the app and open **Settings**
3. Fill in PostgreSQL connection details
4. Click **Initialize / Migrate Database Schema** — this runs `db/schema.sql` and creates all 17 tables

## Run in development

```bash
npm run dev
```

This starts Vite (renderer) + Electron simultaneously.

## Run in production

```bash
npm start
```

## Workflow

1. **Settings** — Set license key, MedScan installation directory, DB connection
2. **NLP Runner** — Select input files/dir, pick cartridges, set output dir, click Run
3. **Results** — Inspect extracted RNEF relations, filter by type or node
4. **Dictionary** — Add/import/browse/export dictionary entries
5. **Patterns** — Browse and open grdata pattern files in your text editor

## Dictionary Import Format

Tab-delimited file (`.txt` or `.tab`):
```
MedscanID<TAB>Alias<TAB>NodeType
<blank for auto> EGFR    Protein
1000042          Aspirin SmallMol
```

NodeType accepts either the Display Name (e.g. `Protein/Gene`) or the RNEF type string (e.g. `Protein`).

## Export

Use Dictionary → Export to Files to write DB records back to cartridge `msdata/` and `xfdata/` directories as tab files.
