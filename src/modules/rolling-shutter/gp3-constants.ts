/**
 * GoPro MISSION 1 rolling shutter constants.
 *
 * The MISSION 1 sensor reads rows top-to-bottom.
 * At 960 fps, total frame time = 1/960 ≈ 1041.67 µs.
 * The sensor has 1080 active rows in full-res; at 960fps the crop
 * reduces to ~480 rows (2:1 vertical binning).
 * Manufacturer scan rate spec: ~1.042 µs per row.
 */

export const GP3_CONSTANTS = {
  /** Frames per second at maximum capture rate */
  MAX_FPS: 960,

  /** Total frame period in microseconds at MAX_FPS */
  FRAME_PERIOD_US: 1_000_000 / 960, // ≈ 1041.67 µs

  /** Number of active rows in the image at MAX_FPS capture mode */
  ACTIVE_ROWS: 480,

  /**
   * Time elapsed between consecutive row reads (µs).
   * Computed as FRAME_PERIOD_US / ACTIVE_ROWS.
   * This is the "rolling shutter skew rate".
   */
  SCAN_RATE_US_PER_ROW: (1_000_000 / 960) / 480, // ≈ 2.17 µs/row

  /** Sensor pixel pitch in µm (approximate for a 1/2.3" sensor) */
  PIXEL_PITCH_UM: 1.55,
} as const;
