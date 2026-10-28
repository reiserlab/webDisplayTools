# Request for rig-nodes: typed host-pressure messages (from the webDisplayTools host-monitor session, 2026-10-28)

## What and why
A generic host monitor node (`rig_nodes.host_monitor`, prototyped in webDisplayTools `rig/nodes/host_monitor.py`
on ww18) publishes PC "pressure" at 1 Hz on `/rig/host`: per-core CPU (mean + peak of 10 Hz sub-windows, the
method of atlas-bench `tools/cpu_sampler.py`), memory, disk, network, NVIDIA GPU, top processes. The arena gateway
records it into each run's MCAP bag. The user chose a TYPED message (plottable live in Foxglove). Please add the
messages below to `rig_interfaces` and release them; until the release lands the node publishes `std_msgs/String`
JSON with the SAME field names (the `--typed auto` pattern of the FicTrac adapter / ArenaFrame).

## Please change
1. `src/rig_interfaces/msg/`: add `HostStats.msg`, `DiskStats.msg`, `NetStats.msg`,
   `GpuStats.msg`, `ProcStats.msg` exactly as below; list them in `CMakeLists.txt` `rosidl_generate_interfaces`.
2. `CONTRACT.md`: a topic-table row
   `| /rig/host | rig_interfaces/HostStats, or std_msgs/String JSON with the same field names | RELIABLE, KEEP_LAST 10, VOLATILE | rig_nodes.host_monitor (default 1 Hz) | one host sample per window; recorded by the arena gateway |`
   and the absent-value rule applies (NaN float / 0 int when the OS gives no value).
3. Bump the package set (new messages = wire-contract change, CONTRACT §7) → 0.3.0, release, and rebuild the
   channel INCLUDING a win-64 `rig_interfaces` build (ww18's env currently has no importable `rig_interfaces`).
4. Reply with: the release tag, whether win-64 `rig_interfaces` is in the channel, and any field you renamed.
   (Optional, later: the node itself moves to `src/rig_nodes/rig_nodes/host_monitor.py` once measured on ww18.)

## Message definitions (normative proposal)

### HostStats.msg
```
# One host-pressure sample (rig_nodes.host_monitor, /rig/host, default 1 Hz). CPU is measured from
# cycle counters every 1/sub_samples of the window (Windows: QueryIdleProcessorCycleTime, exact; Task
# Manager's tick-based numbers step at 15.6 ms) and reported as the window mean AND the busiest
# sub-window, so a short burst on one core is not averaged away. Absent value: NaN (float) / 0 (int).
int64 t_ms                      # wall clock at the END of the window (ms since the Unix epoch)
float32 window_s                # window length, s (1.0 at 1 Hz)
uint32 sub_samples              # CPU sub-windows in this window (10 at the default 10 Hz)
string hostname
# CPU
float32 cpu_busy_cores_mean     # whole-PC busy cores (0..n_cpu), mean over the window
float32 cpu_busy_cores_peak     # busiest sub-window
float32[] core_busy_mean        # per logical CPU, 0..1
float32[] core_busy_peak        # per logical CPU, busiest sub-window, 0..1
uint8[] core_class              # efficiency class per logical CPU (higher = faster: P- vs E-cores); empty if unknown
float32 sampler_late_ms_max     # how late the monitor woke for a sub-window (a PC-wide stall or starvation)
float32 context_switches_per_s
float32 interrupts_per_s
float32 dpcs_per_s              # deferred procedure calls (Windows; soft interrupts elsewhere)
# memory
float32 mem_total_mb
float32 mem_used_mb
float32 mem_available_mb
float32 pagefile_used_mb
float32 hard_page_faults_per_s  # page reads from disk (paging pressure)
# storage of the run log
string log_volume               # the volume holding the run logs / bags
float32 log_volume_free_gb
# devices and processes
DiskStats[] disks               # one per physical disk
NetStats[] nets                 # one per network adapter that is up (Windows does not count loopback)
GpuStats[] gpus                 # one per NVIDIA GPU (NVML); empty without one
ProcStats[] procs               # top N by CPU, by memory and by disk I/O, plus pinned names; deduplicated
float32 monitor_cpu_cores       # this node's own CPU over the window (its cost, always reported)
```

### DiskStats.msg
```
string name                     # PhysicalDrive0 / nvme0n1 / disk0
float32 read_mb_per_s
float32 write_mb_per_s
float32 reads_per_s
float32 writes_per_s
float32 busy_frac               # 0..1, (read + write time) / window; NaN where the OS gives none
```

### NetStats.msg
```
string name                     # adapter name as the OS reports it
float32 rx_mb_per_s
float32 tx_mb_per_s
uint32 errors                   # receive + transmit errors and drops in the window
```

### GpuStats.msg
```
uint32 index
string name
float32 util_frac               # 0..1, GPU core
float32 mem_util_frac           # 0..1, memory controller
float32 mem_used_mb
float32 mem_total_mb
float32 encoder_util_frac       # NVENC, 0..1 (BIAS MP4 recording)
float32 decoder_util_frac       # NVDEC, 0..1
float32 temperature_c
float32 power_w
uint8 pstate                    # 0 = maximum performance … 15; 255 = unknown
uint64 throttle_reasons         # NVML clocks-event (throttle) reason bitmask; 0 = none
```

### ProcStats.msg
```
uint32 pid
string name                     # executable image name
string group                    # pinned group label ("fictrac", "bias", "py:bridge_node", …) or "" for top-N only
float32 cpu_cores               # mean over the window (1.0 = one core busy)
float32 rss_mb                  # working set
float32 io_read_mb_per_s
float32 io_write_mb_per_s
uint8 reasons                   # bitmask: 1 top CPU, 2 top memory, 4 top disk I/O, 8 pinned
```
