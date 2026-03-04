# Muse Headset Connector

## What This Project Does

The Muse Headset Connector is a web application that connects to a Muse EEG headset via the browser's Web Bluetooth API, processes the raw EEG signal into frequency band powers (delta, theta, alpha, beta, gamma) for each electrode, and streams both raw samples and processed data to an MQTT broker. Other applications can subscribe to the configured MQTT topic to receive real-time EEG data for analysis, visualization, or control.

The user must first connect to an MQTT broker (e.g. HiveMQ Cloud) using the on-page form, then click "Connect to Muse" to pair with the headset. Once connected, the page displays live band powers and relative beta for the four electrodes (TP9, TP10, AF7, AF8) and publishes batched data to MQTT at a configurable rate. The page also provides links to external modules (Quick Diagnostic, Average Bandpower, PSD, PSD Spectrogram) that open in separate windows.

---

## Project Files and How They Connect

| File | Purpose |
|------|---------|
| **index.html** | Single-page UI and application logic. Contains the HTML structure (connection status, MQTT config form, Connect to Muse button, modules section, latest data display), all CSS for layout and theming, and a single inline script that: (1) connects to MQTT using the form settings, (2) creates a Physio instance and connects to the Muse when the user clicks Connect to Muse, (3) runs intervals that publish buffered raw samples and processed data to MQTT and update the "Latest Data" section. Depends on the MQTT script from CDN and the local scripts listed below. |
| **js/physio.js** | Defines the `Physio` constructor. Responsibilities: (1) Buffers incoming EEG samples per channel (TP9, TP10, AF7, AF8) in a sliding window used for PSD and band power; (2) Maintains a separate raw sample buffer (up to 1 second) for MQTT; (3) Applies a 7–30 Hz bandpass filter (Fili) and uses BCI.js to compute PSD and band power; (4) Computes relative band powers and stores them on `window.bands` and `window.relativeBeta`; (5) Wraps `Blue.BCIDevice` and passes each incoming packet to `addData`. The UI and MQTT logic in index.html read from `window.bands`, `window.relativeBeta`, and `physio.getRawDataBuffer()` / `physio.clearRawDataBuffer()`. |
| **js/BCIDevice.build.js** | Webpack bundle that exposes `window.Blue.BCIDevice`. This is the Web Bluetooth layer: it discovers and connects to the Muse device and invokes a callback with `{ electrode, data }` for each EEG packet. physio.js creates `new Blue.BCIDevice(callback)` and calls `device.connect()` to start streaming. This file is third-party/bundled; it should not be edited unless rebuilding from source. |
| **js/fili.min.js** | Minified Fili.js library (referenced by index.html). Used in physio.js to design and apply a bandpass FIR filter (7–30 Hz) to the EEG signal before band power computation. |
| **js/bci.min.js** | Minified BCI.js library (referenced by index.html). Used in physio.js for `window.bci.signal.getPSD` and `window.bci.signal.getBandPower` to compute power spectral density and band powers for delta, theta, alpha, beta, gamma. |
| **assets/net.png** | Decorative background image referenced in index.html. |

Data flow in short: **Muse (Bluetooth)** -> **BCIDevice.build.js** -> **physio.js** (buffering, filtering, band powers) -> **index.html** (reads `window.bands` / `window.relativeBeta` and `physio.getRawDataBuffer()`, updates DOM, publishes to **MQTT**).

---

## MQTT Message JSON Layout

Each message published to the configured MQTT topic is a single JSON string. After parsing, the payload has the following structure.

**Top-level object**

| Field | Type | Description |
|-------|------|--------------|
| `batchTimestamp` | string | ISO 8601 timestamp when the batch was created (e.g. `"2025-03-04T12:00:00.000Z"`). |
| `sampleCount` | number | Number of raw samples in the `samples` array. |
| `samples` | array | List of raw EEG sample objects (see below). |
| `processedData` | object | Summary of processed band powers and derived values (see below). |

**Each element of `samples` (raw sample object)**

| Field | Type | Description |
|-------|------|-------------|
| `timestamp` | string | ISO 8601 timestamp when this sample was received. |
| `channel` | number | Muse channel ID: `2` = TP9, `16` = AF7, `3` = TP10, `17` = AF8. |
| `data` | array of numbers | One-element array containing the raw EEG value for this sample. |
| `sampleNumber` | number | Running count used for ordering (resets every second). |
| `packetSize` | number | Always `1` (one sample per object in the buffer). |

**The `processedData` object**

| Field | Type | Description |
|-------|------|-------------|
| `relativeBeta` | number | Relative beta power for channel 2 (TP9): beta / (delta + theta + alpha + beta + gamma). |
| `powerValue` | string | Same as `relativeBeta` multiplied by 100, formatted to 3 decimal places (e.g. `"12.345"`). |
| `bands` | object | Per-electrode relative band powers; keys are `"tp9"`, `"tp10"`, `"af7"`, `"af8"`. |

**Each electrode in `processedData.bands`** (e.g. `processedData.bands.tp9`)

| Field | Type | Description |
|-------|------|-------------|
| `delta` | number | Relative delta band power. |
| `theta` | number | Relative theta band power. |
| `alpha` | number | Relative alpha band power. |
| `beta` | number | Relative beta band power. |
| `gamma` | number | Relative gamma band power. |
| `totalPower` | number | Sum of delta, theta, alpha, beta, and gamma for that electrode. |

**Example (abbreviated)**

```json
{
  "batchTimestamp": "2025-03-04T12:00:00.000Z",
  "sampleCount": 48,
  "samples": [
    {
      "timestamp": "2025-03-04T12:00:00.001Z",
      "channel": 2,
      "data": [ -12.34 ],
      "sampleNumber": 1,
      "packetSize": 1
    }
  ],
  "processedData": {
    "relativeBeta": 0.123,
    "powerValue": "12.300",
    "bands": {
      "tp9": { "delta": 0.2, "theta": 0.15, "alpha": 0.25, "beta": 0.2, "gamma": 0.2, "totalPower": 1.0 },
      "tp10": { "delta": 0.22, "theta": 0.14, "alpha": 0.24, "beta": 0.21, "gamma": 0.19, "totalPower": 1.0 },
      "af7": { "delta": 0.21, "theta": 0.16, "alpha": 0.23, "beta": 0.2, "gamma": 0.2, "totalPower": 1.0 },
      "af8": { "delta": 0.19, "theta": 0.15, "alpha": 0.26, "beta": 0.2, "gamma": 0.2, "totalPower": 1.0 }
    }
  }
}
```

Messages are published at the rate controlled by `MQTT_UPDATE_INTERVAL` in index.html (default 100 ms). The buffer is cleared after each publish, so `samples` typically contains only the raw samples collected since the previous publish.

---

## Detailed Walkthrough of the Code

### index.html

- **Head**
  - Loads MQTT client (CDN), then Fili, BCI, BCIDevice, and Physio in order so that Physio can use Blue.BCIDevice, Fili, and BCI.
  - CSS defines variables for colors, layout for body and status boxes, styles for connected/disconnected state, data grid and band sections, connection status spinner, wave decoration, MQTT config form, and module buttons.

- **Body**
  - Connection status area: spinner and text (e.g. "Searching for MQTT...", "Streaming Data").
  - Two status divs: `#mqttStatus` and `#museStatus`, toggled between "connected" and "disconnected" classes.
  - MQTT config: protocol (WSS/WS), broker URL, port, username, password, topic; buttons "Connect to MQTT" and "Connect to Muse".
  - Modules section: buttons that open external pages (Quick Diagnostic, Average Bandpower, PSD, PSD Spectrogram) in new windows.
  - Data display: `#latestData` (a `<pre>`) is replaced with generated HTML showing timestamp, relative beta, power value, and per-electrode band powers (TP9, TP10, AF7, AF8).

- **Script (DOMContentLoaded)**
  1. **Setup**
     - Verifies `mqtt` is defined (from CDN).
     - Defines `defaultConfig` for broker URL, port, username, password, topic.
     - Declares variables: `client` (MQTT), `physio`, `museDevice`, `museServer`, `connectionCheckInterval`, `dataProcessingInterval`.

  2. **Cleanup**
     - `cleanupIntervals()` clears the two intervals.
     - `cleanupResources()` calls `cleanupIntervals()`, disconnects Physio (if any), ends the MQTT client, and nulls references.

  3. **MQTT config**
     - `getMqttConfig()` reads form fields (with defaults), normalizes the broker URL (protocol prefix and `/mqtt` path), and returns `{ protocol, brokerUrl, port, username, password, topic }`.

  4. **MQTT connection**
     - `setupMqttConnection()` builds options (clientId, username, password, port, protocol), calls `mqtt.connect(config.brokerUrl, options)`, and assigns the client. It then registers:
       - `connect`: set MQTT status to connected, update status text, set button to "Refresh Connection" and disable false.
       - `error` / `close`: call `cleanupResources()`, set status to disconnected/error, reset button to "Connect to MQTT".

  5. **MQTT button**
     - On click: if not connected, call `setupMqttConnection()`; if connected, call `cleanupResources()`, wait 1 second, then call `setupMqttConnection()` again (refresh).

  6. **Muse button**
     - On click: if MQTT not connected, alert and return. Otherwise:
       - `cleanupIntervals()`.
       - Set status text to "Searching for Muse...".
       - Create `physio = new Physio()` and call `physio.start()` (this triggers Web Bluetooth and starts streaming).
       - Start `connectionCheckInterval` (every 100 ms): when `window.relativeBeta` and `window.bands` have data, set Muse status to connected, status text to "Streaming Data...", and clear the interval.
       - Start `dataProcessingInterval` (every 100 ms):
         - **MQTT publish**: If at least `MQTT_UPDATE_INTERVAL` (100 ms) has passed, get `physio.getRawDataBuffer()`. If non-empty, build `batchData` (batchTimestamp, sampleCount, samples, processedData with relativeBeta, powerValue, bands), `JSON.stringify` it, `client.publish(topic, message)`, then `physio.clearRawDataBuffer()` and update `lastMqttUpdateTime`.
         - **DOM update**: If at least `DOM_UPDATE_INTERVAL` (500 ms) has passed, read `window.relativeBeta` and `window.bands`, build a `displayData` object (timestamp, relativeBeta, powerValue, bands for tp9/tp10/af7/af8), and call `updateLatestData('Processed EEG', displayData)`; then update `lastDomUpdateTime`.

  7. **updateLatestData(type, data)**
     - Finds `#latestData`, then sets its `innerHTML` to a large template string: a grid with "Basic Information" (timestamp, relative beta, power value) and four sections (TP9, TP10, AF7, AF8), each with delta/theta/alpha/beta/gamma values from `data.bands`.

  8. **Other**
     - If `museDevice` exists, listen for `gattserverdisconnected` to set Muse status to disconnected and call `cleanupResources()`.
     - On `beforeunload`, call `cleanupResources()`.

### js/physio.js

- **Physio constructor**
  - **State**
    - `buffer`, `rawDataBuffer`, `maxBufferSize` (256), timing and sample-count fields, `samplesPerPacket` (12).
    - Bandpass filter: Fili bandpass 7–30 Hz, 250 Hz, order 128; stored in `filter`.
    - `channels` (per-channel arrays), `window.psd`, `window.bands`, `tempSeriesData`, `isChannelDataReady` for channels 2, 16, 3, 17.
    - `this.SECONDS = 4`, `this.BUFFER_SIZE = 4 * 256`, `window.channelSampleCount`.

  - **addData(sample, channel)**
    - Updates timing and sample count; initializes `channels[channel]` and `channelSampleCount[channel]` if needed.
    - For each value in `sample`: append to channel buffer (sliding window of size `BUFFER_SIZE`), increment channel sample count, push a raw sample object (timestamp, channel, data, sampleNumber, packetSize) onto `rawDataBuffer`, and trim `rawDataBuffer` to `maxBufferSize`.
    - Set `tempSeriesData[channel]` and `isChannelDataReady[channel] = true`.

  - **Getters**
    - `getLenght` / `getBuffer`: legacy buffer.
    - `getRawDataBuffer()`: returns `rawDataBuffer`.
    - `clearRawDataBuffer()`: clears `rawDataBuffer`.

  - **psdToPlotPSD(psd, max)**
    - Converts PSD array to `[{ x, y }, ...]` for plotting, up to frequency index `max`.

  - **getBandPower(channel, band)**
    - If channel buffer has fewer than `BUFFER_SIZE` samples, return 0. Otherwise: filter channel with `filter.simulate(channels[channel])`, compute PSD with `window.bci.signal.getPSD`, store in `window.psd[channel]`, then return `window.bci.signal.getBandPower(..., band)`.

  - **getRelativeBandPower(channel, band)**
    - Target band power divided by the sum of delta, theta, alpha, beta, and gamma band powers for that channel.

  - **checkForVisualizationRefresh()**
    - When all four channels (2, 16, 3, 17) are ready, reset their ready flags, then for each electrode (2->tp9, 3->tp10, 17->af8, 16->af7) compute relative band powers and set `window.bands["tp9"]` etc. with delta, theta, alpha, beta, gamma, totalPower. If `window.bpGraph` exists, update its series with band power data and call `update()`. If `window.psdGraph` and PSD data exist, fill series from `window.psd[2/3/16/17]` via `psdToPlotPSD` and call `update()`.

  - **Device and start**
    - `this.device = new Blue.BCIDevice(callback)`. The callback receives `sample` with `electrode` and `data`, calls `this.addData(data, electrode)`, sets `window.relativeBeta = getRelativeBandPower(2, "beta")`, and calls `checkForVisualizationRefresh()`.
    - `this.start()` calls `this.device.connect()` to begin Web Bluetooth connection and streaming.

### js/BCIDevice.build.js

- This is a prebuilt webpack bundle. It attaches `window.Blue` with the BCIDevice API used by physio.js. The only integration point is: create `new Blue.BCIDevice(callback)` and call `.connect()`; the callback receives EEG packets. No edits are required for normal use or modification of the rest of the project.

---

## How to Modify the Code

- **Change MQTT publish rate or payload**: In index.html, adjust `MQTT_UPDATE_INTERVAL` and the structure of `batchData` inside `dataProcessingInterval`. To add more processed fields, ensure they are set on `window` in physio.js (or returned by a Physio method) and then include them in `batchData.processedData`.

- **Change band power or filtering**: In physio.js, edit the Fili filter parameters (e.g. `lowFreq`, `highFreq`, `filterOrder`) and the band power logic in `getBandPower` / `getRelativeBandPower`. Band names and ranges come from BCI.js.

- **Change UI or layout**: Edit the HTML and CSS in index.html. The "Latest Data" content is generated in `updateLatestData()`; change the template string there to add/remove or rename fields.

- **Add new modules**: Add another button in the "Modules" section and set its `onclick` to `window.open(...)` with the module URL and window options.

- **Default MQTT settings**: Update the `defaultConfig` object and, if desired, the form placeholders in index.html.

- **Electrode/channel mapping**: Channel IDs 2, 16, 3, 17 map to TP9, AF7, TP10, AF8 in physio.js. Changing this mapping requires updating `checkForVisualizationRefresh` and any code that assumes `window.bands.tp9` etc.

Running the project: serve the project directory over HTTPS (required for Web Bluetooth and secure MQTT). Open index.html, connect to MQTT, then connect to the Muse headset. Data will appear in the Latest Data section and be published to the configured MQTT topic.

### Broker configuration

The web app and the standalone MQTT client both use HiveMQ Cloud (WSS). Broker hostname, port, username, and password are set in `initializeMQTT()` in `app.js` and in `mqtt_client.js`. To use a different HiveMQ cluster, update the `hostname` (and optionally `port`) in both places; keep the same username and password, or obtain new credentials from the project maintainer and update the config accordingly.
