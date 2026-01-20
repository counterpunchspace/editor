# Debug script to check matplotlib internal state
# Run this between executions of matplotlib scripts to see if figures are accumulating

try:
    import matplotlib.pyplot as plt
    import gc
    
    # Get all matplotlib figures
    figs = plt.get_fignums()
    print(f"Active matplotlib figures: {len(figs)}")
    print(f"Figure numbers: {figs}")
    
    # Get garbage collector stats
    gc_stats = gc.get_stats()
    gc_count = gc.get_count()
    print(f"GC stats - generation counts: {gc_count}")
    
    # Check for matplotlib objects in memory
    matplotlib_objects = [obj for obj in gc.get_objects() if 'matplotlib' in str(type(obj))]
    print(f"Total matplotlib objects in memory: {len(matplotlib_objects)}")
    
    # Close all figures
    plt.close('all')
    print("Closed all matplotlib figures")
    
    # Force garbage collection
    collected = gc.collect()
    print(f"Garbage collected {collected} objects")
    
except ImportError:
    print("matplotlib not installed yet")
