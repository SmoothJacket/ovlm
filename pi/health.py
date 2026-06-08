"""
Pi system health — reads CPU temp, memory, and load from /proc and /sys.
No external dependencies (pure stdlib + Linux procfs).
"""

import os
from typing import NamedTuple


class HealthSnapshot(NamedTuple):
    cpu_temp_c:    float   # °C, -1 if unreadable
    mem_used_mb:   float
    mem_total_mb:  float
    load_avg_1m:   float   # 1-minute load average


def read_health() -> HealthSnapshot:
    return HealthSnapshot(
        cpu_temp_c   = _cpu_temp(),
        mem_used_mb  = _mem_used_mb(),
        mem_total_mb = _mem_total_mb(),
        load_avg_1m  = _load_avg(),
    )


def _cpu_temp() -> float:
    paths = [
        "/sys/class/thermal/thermal_zone0/temp",
        "/sys/devices/virtual/thermal/thermal_zone0/temp",
    ]
    for p in paths:
        try:
            with open(p) as f:
                return int(f.read().strip()) / 1000.0
        except OSError:
            pass
    return -1.0


def _mem_info() -> dict:
    result = {}
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                parts = line.split()
                if len(parts) >= 2:
                    result[parts[0].rstrip(":")] = int(parts[1])  # kB
    except OSError:
        pass
    return result


def _mem_total_mb() -> float:
    info = _mem_info()
    return info.get("MemTotal", 0) / 1024.0


def _mem_used_mb() -> float:
    info = _mem_info()
    total     = info.get("MemTotal",     0)
    available = info.get("MemAvailable", 0)
    return max(0, total - available) / 1024.0


def _load_avg() -> float:
    try:
        with open("/proc/loadavg") as f:
            return float(f.read().split()[0])
    except (OSError, ValueError):
        return 0.0
