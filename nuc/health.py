"""
NUC system health — reads CPU temp, memory, and load via psutil.
Falls back gracefully when sensors aren't available (common on Windows).
"""

from typing import NamedTuple

try:
    import psutil
    PSUTIL_AVAILABLE = True
except ImportError:
    PSUTIL_AVAILABLE = False


class HealthSnapshot(NamedTuple):
    cpu_temp_c:    float   # °C, -1 if unreadable
    mem_used_mb:   float
    mem_total_mb:  float
    load_avg_1m:   float   # 1-min load avg on Linux/macOS; CPU% on Windows


def read_health() -> HealthSnapshot:
    if not PSUTIL_AVAILABLE:
        return HealthSnapshot(-1.0, 0.0, 0.0, 0.0)
    return HealthSnapshot(
        cpu_temp_c   = _cpu_temp(),
        mem_used_mb  = _mem_used_mb(),
        mem_total_mb = _mem_total_mb(),
        load_avg_1m  = _load_avg(),
    )


def _cpu_temp() -> float:
    try:
        temps = psutil.sensors_temperatures()
        if not temps:
            return -1.0
        for name in ('coretemp', 'cpu_thermal', 'acpitz', 'k10temp'):
            entries = temps.get(name)
            if entries:
                return entries[0].current
        for entries in temps.values():
            if entries:
                return entries[0].current
    except (AttributeError, Exception):
        pass
    return -1.0


def _mem_used_mb() -> float:
    vm = psutil.virtual_memory()
    return vm.used / (1024 * 1024)


def _mem_total_mb() -> float:
    vm = psutil.virtual_memory()
    return vm.total / (1024 * 1024)


def _load_avg() -> float:
    # psutil.getloadavg() is not available on Windows; fall back to CPU%
    try:
        return psutil.getloadavg()[0]
    except AttributeError:
        return psutil.cpu_percent(interval=None) / 100.0
