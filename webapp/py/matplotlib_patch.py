# Matplotlib auto-cleanup patch
# Automatically close all figures after plt.show() to prevent memory accumulation

import sys

# Always try to patch if matplotlib is imported
try:
    import matplotlib.pyplot as plt
    
    # Check if already patched
    if not hasattr(plt.show, '_autopatch_applied'):
        # Store the original show function
        _original_show = plt.show
        
        # Create a wrapper that closes all figures after showing
        def show_and_close(*args, **kwargs):
            """Show plots and automatically close all figures to free memory"""
            result = _original_show(*args, **kwargs)
            # Close all figures after showing
            plt.close('all')
            return result
        
        # Mark as patched
        show_and_close._autopatch_applied = True
        
        # Replace plt.show with our wrapper
        plt.show = show_and_close
        
        print("[MatplotlibPatch] ✅ Installed auto-cleanup patch for plt.show()")
    else:
        print("[MatplotlibPatch] ⏭️ Patch already applied, skipping")
        
except ImportError:
    # Matplotlib not loaded yet, that's fine
    print("[MatplotlibPatch] ⚠️ Matplotlib not yet imported, patch will wait")
except Exception as e:
    print(f"[MatplotlibPatch] ❌ Failed to patch matplotlib: {e}")
