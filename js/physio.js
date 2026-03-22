/**
 * Physio - Manages physiological (EEG) data from the Muse headset.
 * Buffers samples per channel, applies a bandpass filter, computes PSD and band powers
 * (delta, theta, alpha, beta, gamma) for each electrode, and exposes data for MQTT and UI.
 * @class
 */

var Physio = function () {
  // General buffer (legacy); not used for MQTT
  this.buffer = [];
  // Accumulates raw samples for the last second; consumed by index.html and sent over MQTT in batches
  this.rawDataBuffer = [];
  // Cap on rawDataBuffer length: 1 second of data at 256 Hz
  this.maxBufferSize = 256;
  this.lastSampleTime = 0;
  this.sampleCount = 0;
  this.lastSecondTime = 0;
  // Muse sends 12 samples per packet per channel
  this.samplesPerPacket = 12;

  // Muse channel IDs: 2 = TP9, 16 = AF7, 3 = TP10, 17 = AF8

  // Bandpass filter (7-30 Hz) for focusing on relevant EEG bands; 250 Hz sample rate, 128-tap FIR
  sampleRate = 250;
  lowFreq = 7;
  highFreq = 30;
  filterOrder = 128;
  firCalculator = new Fili.FirCoeffs();
  coeffs = firCalculator.bandpass({
    order: filterOrder,
    Fs: sampleRate,
    F1: lowFreq,
    F2: highFreq,
  });
  filter = new Fili.FirFilter(coeffs);

  // Per-channel sample arrays; keys are channel IDs (2, 16, 3, 17)
  channels = {};
  // Power spectral density per channel; populated for PSD visualizations
  window.psd = {};
  // Relative band powers per electrode (tp9, tp10, af7, af8); used by UI and MQTT
  window.bands = {};
  tempSeriesData = {};
  // Flags indicating whether each channel has received new data in the current refresh cycle
  isChannelDataReady = { 2: false, 16: false, 3: false, 17: false };
  // Number of seconds of data kept per channel for PSD/band power computation
  this.SECONDS = 4;

  window.channelSampleCount = {};
  // Total samples per channel buffer: 4 seconds * 256 Hz
  this.BUFFER_SIZE = this.SECONDS * 256;
  this.isConnected = false;

  /**
   * Adds a packet of samples for one channel: appends to channel buffer, pushes raw samples
   * into rawDataBuffer (for MQTT), and marks the channel as ready for band power refresh.
   */
  this.addData = (sample, channel) => {
    const currentTime = Date.now();

    if (this.lastSampleTime === 0) {
      this.lastSampleTime = currentTime;
      this.lastSecondTime = currentTime;
    }
    this.sampleCount += sample.length;
    if (currentTime - this.lastSecondTime >= 1000) {
      this.sampleCount = 0;
      this.lastSecondTime = currentTime;
    }

    if (!channels[channel]) {
      channels[channel] = [];
      window.channelSampleCount[channel] = 0;
    }

    for (let i = 0; i < sample.length; i++) {
      // Maintain a sliding window of BUFFER_SIZE samples per channel (oldest removed)
      if (channels[channel].length > this.BUFFER_SIZE - 1) {
        channels[channel].shift();
      }
      channels[channel].push(sample[i]);
      window.channelSampleCount[channel] = window.channelSampleCount[channel] + 1;

      // One raw sample object per value for MQTT; capped at maxBufferSize
      const rawSample = {
        timestamp: new Date().toISOString(),
        channel: channel,
        data: [sample[i]],
        sampleNumber: this.sampleCount + i,
        packetSize: 1
      };
      this.rawDataBuffer.push(rawSample);
      if (this.rawDataBuffer.length > this.maxBufferSize) {
        this.rawDataBuffer.shift();
      }
    }

    tempSeriesData[channel] = sample;
    isChannelDataReady[channel] = true;
  };

  this.getLenght = () => {
    return this.buffer.length;
  };

  this.getBuffer = () => {
    return this.buffer;
  };

  /** Returns the array of raw samples (used by index.html to publish to MQTT). */
  this.getRawDataBuffer = () => {
    return this.rawDataBuffer;
  };

  /** Clears the raw sample buffer after sending to MQTT to avoid re-sending the same data. */
  this.clearRawDataBuffer = () => {
    this.rawDataBuffer = [];
  };

  /** Converts PSD array to plot format: array of { x: frequency index, y: power } up to max frequency index. */
  psdToPlotPSD = function (psd, max) {
    out = [];
    for (i in psd) {
      out.push({ x: parseInt(i), y: psd[i] });
      if (i > max) {
        return out;
      }
    }
  };

  /** Computes absolute band power for one channel and band (delta/theta/alpha/beta/gamma). Uses filtered signal and BCI PSD/band power. */
  var getBandPower = (channel, band) => {
    if (!channels[channel]) return 0;

    if (channels[channel].length < this.BUFFER_SIZE) {
      return 0;
    }

    signal = filter.simulate(channels[channel]);
    let psd = window.bci.signal.getPSD(this.BUFFER_SIZE, channels[channel]);

    psd.shift();
    window.psd[channel] = psd;

    let bp = window.bci.signal.getBandPower(this.BUFFER_SIZE, psd, 256, band);

    return bp;
  };

  /** Relative band power: target band power divided by sum of all band powers for that channel. */
  var getRelativeBandPower = (channel, band) => {
    var target = getBandPower(channel, band);
    var delta = getBandPower(channel, "delta");
    var theta = getBandPower(channel, "theta");
    var alpha = getBandPower(channel, "alpha");
    var beta = getBandPower(channel, "beta");
    var gamma = getBandPower(channel, "gamma");
    var sum = delta + theta + alpha + beta + gamma;
    return sum > 0 ? target / sum : 0;
  };

  /**
   * Computes a 0-1 focus/engagement score from all four Muse channels using:
   * (1) Average relative beta across TP9, TP10, AF7, AF8 (alertness/active thinking),
   * (2) Theta/beta component: beta/(theta+beta) averaged across channels (lower theta vs beta = more focus),
   * (3) Alpha blocking: 1 - average relative alpha (lower alpha when mentally engaged).
   * Sets window.relativeBeta to this score (used as powerValue * 100 in UI/MQTT) and window.focusComponents
   * (avgRelativeBeta is stored as 0–100; other components remain 0–1).
   */
  var computeFocusScore = function () {
    if (!window.bands || !window.bands.tp9 || !window.bands.tp10 || !window.bands.af7 || !window.bands.af8) {
      return;
    }
    var electrodes = ["tp9", "tp10", "af7", "af8"];
    var sumBeta = 0, sumThetaBeta = 0, sumAlpha = 0;
    for (var i = 0; i < electrodes.length; i++) {
      var b = window.bands[electrodes[i]];
      sumBeta += b.beta;
      var theta = b.theta, beta = b.beta;
      sumThetaBeta += (theta + beta) > 0 ? beta / (theta + beta) : 0;
      sumAlpha += b.alpha;
    }
    var avgRelativeBeta = sumBeta / 4;
    var thetaBetaComponent = sumThetaBeta / 4;
    var alphaBlockingComponent = 1 - (sumAlpha / 4);
    window.focusComponents = {
      avgRelativeBeta: avgRelativeBeta * 100,
      thetaBetaComponent: thetaBetaComponent,
      alphaBlockingComponent: alphaBlockingComponent
    };
    var focus = (avgRelativeBeta + thetaBetaComponent + alphaBlockingComponent) / 3;
    window.relativeBeta = Math.max(0, Math.min(1, focus));
  };

  /** When all four channels have new data, compute band powers for tp9/tp10/af7/af8 and optionally refresh bpGraph/psdGraph if they exist. */
  var checkForVisualizationRefresh = function () {
    if (
      isChannelDataReady[2] &&
      isChannelDataReady[3] &&
      isChannelDataReady[16] &&
      isChannelDataReady[17]
    ) {
      // Reset channel ready flags
      isChannelDataReady[2] = false;
      isChannelDataReady[3] = false;
      isChannelDataReady[16] = false;
      isChannelDataReady[17] = false;

      // Compute relative band powers for each electrode (channel 2 = TP9, 3 = TP10, 16 = AF7, 17 = AF8)
      delta = getRelativeBandPower(2, "delta");
      theta = getRelativeBandPower(2, "theta");
      alpha = getRelativeBandPower(2, "alpha");
      beta = getRelativeBandPower(2, "beta");
      gamma = getRelativeBandPower(2, "gamma");
      totalPower = delta + theta + alpha + beta + gamma;
      window.bands["tp9"] = { delta, theta, alpha, beta, gamma, totalPower };

      delta = getRelativeBandPower(3, "delta");
      theta = getRelativeBandPower(3, "theta");
      alpha = getRelativeBandPower(3, "alpha");
      beta = getRelativeBandPower(3, "beta");
      gamma = getRelativeBandPower(3, "gamma");
      totalPower = delta + theta + alpha + beta + gamma;
      window.bands["tp10"] = { delta, theta, alpha, beta, gamma, totalPower };

      delta = getRelativeBandPower(17, "delta");
      theta = getRelativeBandPower(17, "theta");
      alpha = getRelativeBandPower(17, "alpha");
      beta = getRelativeBandPower(17, "beta");
      gamma = getRelativeBandPower(17, "gamma");
      totalPower = delta + theta + alpha + beta + gamma;
      window.bands["af8"] = { delta, theta, alpha, beta, gamma, totalPower };

      delta = getRelativeBandPower(16, "delta");
      theta = getRelativeBandPower(16, "theta");
      alpha = getRelativeBandPower(16, "alpha");
      beta = getRelativeBandPower(16, "beta");
      gamma = getRelativeBandPower(16, "gamma");
      totalPower = delta + theta + alpha + beta + gamma;
      window.bands["af7"] = { delta, theta, alpha, beta, gamma, totalPower };

      computeFocusScore();

      if (window.bpGraph) {
        var tp9Data = [{ x: 0, y: theta }, { x: 1, y: alpha }, { x: 2, y: beta }, { x: 3, y: gamma }];
        window.bpGraph.series[0].data = tp9Data;

        var tp10Data = [{ x: 0, y: theta }, { x: 1, y: alpha }, { x: 2, y: beta }, { x: 3, y: gamma }];
        window.bpGraph.series[1].data = tp10Data;

        var af8Data = [{ x: 0, y: theta }, { x: 1, y: alpha }, { x: 2, y: beta }, { x: 3, y: gamma }];
        window.bpGraph.series[2].data = af8Data;

        var af7Data = [{ x: 0, y: theta }, { x: 1, y: alpha }, { x: 2, y: beta }, { x: 3, y: gamma }];
        window.bpGraph.series[3].data = af7Data;
        window.bpGraph.update();
      }

      if (window.psdGraph && window.psd[2] && window.psd[3]) {
        psdPlotData = psdToPlotPSD(window.psd[2], 120);
        window.psdGraph.series[0].data = psdPlotData;
        psdPlotData = psdToPlotPSD(window.psd[3], 120);
        window.psdGraph.series[1].data = psdPlotData;
        psdPlotData = psdToPlotPSD(window.psd[16], 120);
        window.psdGraph.series[2].data = psdPlotData;
        psdPlotData = psdToPlotPSD(window.psd[17], 120);
        window.psdGraph.series[3].data = psdPlotData;
        window.psdGraph.update();
      }
    }
  };

  // BCIDevice (from BCIDevice.build.js) connects via Web Bluetooth and invokes this callback with { electrode, data } per packet
  this.device = new Blue.BCIDevice((sample) => {
    let { electrode, data } = sample;
    this.addData(data, electrode);
    checkForVisualizationRefresh();
  });

  /** Initiates Web Bluetooth connection to the Muse device and starts streaming EEG data. */
  this.start = () => {
    this.device.connect();
  };

  return this;
};
