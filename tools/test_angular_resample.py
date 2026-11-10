"""Same vectors as rdf-node tests/test_angular.py: the edge and the console must rebuild the same curve."""
import math
import unittest

from tools.rdf_node_mqtt_v2 import upsample_pairs


def average_pairs(values):
    return [round((values[2 * k] + values[2 * k + 1]) / 2, 2) for k in range(len(values) // 2)]


def spike(index, size=180):
    values = [0.0] * size
    values[index] = 1.0
    return values


class UpsamplePairsTests(unittest.TestCase):
    def test_constant(self) -> None:
        for value in upsample_pairs([0.7] * 180):
            self.assertAlmostEqual(value, 0.7, places=9)

    def test_reconstructs_a_real_lobe(self) -> None:
        original = [round(1.3 * math.exp(-((((d - 137 + 180) % 360) - 180) / 10) ** 2), 2) for d in range(360)]
        up = upsample_pairs(average_pairs(original))
        self.assertEqual(len(up), 360)
        self.assertLess(max(abs(a - b) for a, b in zip(up, original)), 0.02)
        self.assertLessEqual(abs(up.index(max(up)) - 137), 1)

    def test_no_overshoot(self) -> None:
        up = upsample_pairs(spike(90))
        self.assertGreaterEqual(min(up), 0.0)
        self.assertLessEqual(max(up), 1.0)

    def test_wraps_without_a_seam(self) -> None:
        up = upsample_pairs(spike(179))
        self.assertIn(up.index(max(up)), (358, 359))
        self.assertAlmostEqual(up[359], up[358])
        self.assertAlmostEqual(up[0], up[357])
        up = upsample_pairs(spike(0))
        self.assertIn(up.index(max(up)), (0, 1))
        self.assertAlmostEqual(up[0], up[1])
        self.assertAlmostEqual(up[359], up[2])

    def test_matches_the_edge_reference(self) -> None:
        # Values computed by rdf-node 1.12 rdf_node.angular.upsample_pairs for this input.
        up = upsample_pairs([round(0.5 + (k % 7) / 10, 2) for k in range(180)])
        self.assertEqual([round(x, 6) for x in up[:6]], EDGE_REFERENCE)


EDGE_REFERENCE = [0.5625, 0.510938, 0.570312, 0.625, 0.675, 0.725]

if __name__ == "__main__":
    unittest.main()
