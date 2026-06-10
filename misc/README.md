# Flow Plotter

This is a static HTML + JavaScript app for inspecting uploaded FCS flow
cytometry files. It parses FCS metadata locally, so files are not uploaded to a
server.

## Run

Open `index.html` directly in a browser, or serve the folder with any static
HTTP server:

```bash
python3 -m http.server 8000
```

Then open:

```text
http://localhost:8000/
```

## Workflow

1. Drop or choose one or more `.fcs` files.
2. The app reads only each file's FCS header and TEXT metadata.
3. Each parsed file appears as a row in the file table.
4. Fill in strain, timepoint, and replicate for each file.
5. The combined FCS parameter names populate the channel-mapping controls.
