"""viz_capture.py — record viz_node's outputs (+ two alignment topics) into an MCAP bag.

    python viz_capture.py <out_bag_dir> <stop_file>

Subscribes to every topic viz_node publishes (std types) and to /arena/frame + /bias/status as
played back by `ros2 bag play` (used afterwards to shift the recording onto the original run's
timeline). rosbag2_py's SequentialWriter embeds the message definitions, so Foxglove decodes the
CDR natively. Writes in-process and closes cleanly when <stop_file> appears (no signals needed
on Windows).
"""
import os
import sys
import time

import rclpy
import rosbag2_py
from diagnostic_msgs.msg import DiagnosticArray
from rclpy.node import Node
from rclpy.qos import QoSDurabilityPolicy, QoSHistoryPolicy, QoSProfile, QoSReliabilityPolicy
from std_msgs.msg import Bool, Float64, String
from visualization_msgs.msg import MarkerArray

F64 = ["/viz/fictrac/heading_deg", "/viz/fictrac/turn_deg", "/viz/fictrac/speed_dps", "/viz/fictrac/fwd_rad",
       "/viz/fictrac/side_rad", "/viz/fictrac/fwd_dps", "/viz/fictrac/side_dps", "/viz/fictrac/rate_hz",
       "/viz/arena/index", "/viz/arena/azimuth_deg", "/viz/arena/display_deg",
       "/viz/arena/bias_deg", "/viz/kinefly/left_deg", "/viz/kinefly/right_deg", "/viz/kinefly/lmr_deg",
       "/viz/kinefly/wbf_hz", "/viz/bias/frame_count", "/viz/bias/fps"]
TOPICS = ([(t, Float64, "std_msgs/msg/Float64") for t in F64]
          + [(t, Bool, "std_msgs/msg/Bool") for t in ("/viz/bias/reachable", "/viz/bias/capturing", "/viz/bias/logging")]
          + [(t, String, "std_msgs/msg/String") for t in ("/viz/bias/state", "/viz/last_error")]
          + [("/diagnostics", DiagnosticArray, "diagnostic_msgs/msg/DiagnosticArray"),
             ("/viz/markers", MarkerArray, "visualization_msgs/msg/MarkerArray")])
ALIGN = [("/arena/frame", String, "std_msgs/msg/String"), ("/bias/status", String, "std_msgs/msg/String")]

RELIABLE = QoSProfile(reliability=QoSReliabilityPolicy.RELIABLE, history=QoSHistoryPolicy.KEEP_LAST, depth=2000,
                      durability=QoSDurabilityPolicy.VOLATILE)
BEST = QoSProfile(reliability=QoSReliabilityPolicy.BEST_EFFORT, history=QoSHistoryPolicy.KEEP_LAST, depth=2000,
                  durability=QoSDurabilityPolicy.VOLATILE)


def main() -> int:
    out, stop_file = sys.argv[1], sys.argv[2]
    rclpy.init()
    node = Node("viz_capture")
    w = rosbag2_py.SequentialWriter()
    w.open(rosbag2_py.StorageOptions(uri=out, storage_id="mcap"),
           rosbag2_py.ConverterOptions(input_serialization_format="cdr", output_serialization_format="cdr"))
    counts = {}
    for i, (topic, cls, tname) in enumerate(TOPICS + ALIGN):
        w.create_topic(rosbag2_py.TopicMetadata(id=i, name=topic, type=tname, serialization_format="cdr"))
        counts[topic] = 0

        def cb(data, topic=topic):
            w.write(topic, data, time.time_ns())
            counts[topic] += 1

        node.create_subscription(cls, topic, cb, BEST if (topic, cls, tname) in ALIGN else RELIABLE, raw=True)
    print("[capture] up", flush=True)
    try:
        while rclpy.ok() and not os.path.exists(stop_file):
            rclpy.spin_once(node, timeout_sec=0.1)
    finally:
        w.close()  # writes metadata.yaml
        print("[capture] " + " ".join(f"{t}={n}" for t, n in counts.items() if n), flush=True)
        node.destroy_node()
        rclpy.try_shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
