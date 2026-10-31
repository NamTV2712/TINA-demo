import unittest
from acceptance_report import latency, memory_trend


class AcceptanceReporting(unittest.TestCase):
    def test_missing_warmup_is_not_zero_growth(self):
        self.assertEqual(memory_trend([{'at':0,'rss':1024}], 'rss')['status'],'insufficient-post-warmup-samples')

    def test_per_process_growth_uses_post_warmup(self):
        rows=[{'at':i*60,'rss':i*1024**2} for i in range(20)]
        result=memory_trend(rows,'rss')
        self.assertEqual(result['post_warmup_samples'],10)
        self.assertAlmostEqual(result['linear_slope_mib_per_minute'],1)

    def test_negative_clock_samples_are_preserved(self):
        result=latency([-1,0,2])
        self.assertEqual(result['negative_samples'],1)
        self.assertEqual(result['samples'],3)
        self.assertEqual(result['p95_s'],2)


if __name__=='__main__':unittest.main()
