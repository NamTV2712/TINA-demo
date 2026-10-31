import unittest
import numpy as np
from meeting_e2e import speaker_metrics, pcm, RATE


class SpeakerScoringTests(unittest.TestCase):
    def test_permutation_and_missed_speech(self):
        ref=[{'speaker':name,'start_ms':i*2000+500,'end_ms':i*2000+1500} for i,name in enumerate(['A','B','C'])]
        turns=[dict(t,speaker=cluster) for t,cluster in zip(ref,[2,0,1])]
        metric=speaker_metrics(ref,turns,np.zeros(RATE*6,dtype=np.int16))
        self.assertEqual(metric['speech_label_accuracy'],1)
        self.assertEqual(metric['mapping'],{'0':'B','1':'C','2':'A'})
        turns[0]=dict(turns[0],end_ms=1000)
        metric=speaker_metrics(ref,turns,np.zeros(RATE*6,dtype=np.int16))
        self.assertAlmostEqual(metric['miss_rate'],1/6)
        self.assertEqual(metric['confusion_rate'],0)

    def test_merged_voices_are_penalized_and_wrong_count_stays_visible(self):
        ref=[{'speaker':name,'start_ms':i*1000,'end_ms':(i+1)*1000} for i,name in enumerate(['A','B','C'])]
        turns=[dict(t,speaker=0) for t in ref]
        metric=speaker_metrics(ref,turns,np.zeros(RATE*3,dtype=np.int16))
        self.assertEqual(metric['detected_clusters'],1)
        self.assertFalse(metric['speaker_count_matches'])
        self.assertAlmostEqual(metric['speech_label_accuracy'],1/3)


if __name__=='__main__':unittest.main()
