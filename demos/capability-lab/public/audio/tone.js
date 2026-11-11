/* global AudioWorkletProcessor, currentFrame, registerProcessor, sampleRate */

registerProcessor(
  "capability-tone",
  class extends AudioWorkletProcessor {
    ready = false;

    process(_inputs, outputs) {
      for (const output of outputs) {
        for (const channel of output) {
          for (let index = 0; index < channel.length; index++) {
            channel[index] =
              Math.sin(
                (2 * Math.PI * 220 * (currentFrame + index)) / sampleRate
              ) * 0.05;
          }
        }
      }
      if (!this.ready) {
        this.ready = true;
        this.port.postMessage({ ready: true });
      }
      return true;
    }
  }
);
