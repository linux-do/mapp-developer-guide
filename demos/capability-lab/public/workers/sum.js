self.onmessage = ({ data }) => {
  const values = data instanceof Float64Array ? Array.from(data) : data;
  if (
    !Array.isArray(values) ||
    values.some((value) => !Number.isFinite(value))
  ) {
    self.postMessage({ error: "INVALID_ARGUMENTS" });
    return;
  }
  self.postMessage({ sum: values.reduce((total, value) => total + value, 0) });
};
