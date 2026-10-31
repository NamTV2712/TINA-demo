"""Sanitize FunASR FSMN span records; never persist text, filenames or waveform data."""
from numbers import Real

def ranges(value):
    result=[]
    if not isinstance(value,(list,tuple)):
        return result
    for row in value:
        if not isinstance(row,dict):
            continue
        spans=row.get('value',[])
        for span in spans if isinstance(spans,(list,tuple)) else []:
            if isinstance(span,(list,tuple)) and len(span)>=2 and all(isinstance(x,Real) for x in span[:2]) and span[1]>span[0]:
                result.append([float(span[0])/1000,float(span[1])/1000])
    return result
