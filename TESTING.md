# Icon Generator Testing Checklist

## How to Test

1. Open http://localhost:8080/test_generate_icons.html (or on GitHub Pages)
2. The page will automatically generate 5 test icons
3. Download each PNG and verify the results match expectations

## Test Cases

### Test 1: All-On (Full Arena)
**Expected:** Solid green ring (donut shape)
- Uniform LED green color (#00e676)
- Thick outer outline, thin inner outline
- No gaps or variations
- Dark background

### Test 2: Grating Pattern
**Expected:** 10 vertical stripes alternating dark/bright
- Clear alternating pattern (20 pixels on/off)
- Stripes should be visible and distinct
- NOT solid green (that was the bug!)
- Each stripe ~36° wide (360°/10 stripes)

### Test 3: Sine Pattern
**Expected:** Smooth brightness gradient around the ring
- Varies from dark to bright smoothly
- ~3 complete cycles around the arena
- NOT flat medium green (that was the bug!)
- Should see clear brightness variation

### Test 4: Partial Arena (White Background)
**Expected:** Gap with radial lines
- Green appears on ~288° (8 of 10 columns)
- Gap of ~72° (2 missing columns)
- Radial lines connecting inner/outer at gap boundaries
- White background visible in gap area
- Gap orientation: columns 0 and 9 missing

### Test 5: Partial Arena (Dark Background)
**Expected:** Same as Test 4 but with dark background
- Dark background visible in gap area
- Gap clearly delineated by radial lines

## Bugs That Were Fixed

1. **Sine Pattern** - Was using 0-1 values instead of 0-15 for GS16 mode
   - Resulted in flat medium green
   - Fixed: Now generates proper 0-15 range

2. **Arc Rendering** - Canvas arc() drew wrong direction for CW column order
   - When endAngle < startAngle, arc drew the long way around
   - Resulted in solid colors instead of patterns
   - Fixed: Use Math.min/max to always draw shorter arc

3. **PatParser** - Would error on GitHub Pages if script didn't load
   - Now shows clear error message

## Arena Orientation Notes

Current column mapping (column_order='cw'):
- Column 0 starts at south (-90°)
- Columns increase counter-clockwise (angles decrease)
- For partial arena test: columns 0 and 9 are missing

Expected orientation for partial arenas:
- Gap should appear at bottom (south) for R/L symmetry
- Currently gap appears bottom-right
- May need further adjustment to column_order or angle_offset

## Next Steps

If tests pass:
- ✓ Merge PR
- Consider adding more arena configs for testing
- Address partial arena orientation if needed

If tests fail:
- Check browser console for errors
- Verify PANEL_SPECS and arena-configs.js loaded correctly
- Test with different arena configurations
