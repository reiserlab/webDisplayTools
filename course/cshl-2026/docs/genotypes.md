<div class="genotype-intro">
  <div class="genotype-intro-copy">
    <h1>Fly Stock Genotypes</h1>
    <p>Use these line shorthand names when entering run metadata in Arena Studio. The same names appear in the saved run metadata, so they are what you will use later to group and compare experiments.</p>
    <p>The convention is:</p>
    <pre><code>driver &gt; effector</code></pre>
    <p>Parentheses hold the driver or stock identifier when the common name alone is ambiguous. Sex, food, cross date, and full chromosome-level genotype are not encoded in the shorthand name; record sex separately in run metadata and use this document for interpretation.</p>
  </div>
  <div class="image-with-credit genotype-intro-image">
    <img src="assets/ed_fly_boxes.jpg" alt="Fly boxes">
    <span>Flies by Ed Rogers</span>
  </div>
</div>

## Line Shorthand Names

| Line shorthand | Course use | Sexes available | Food / condition | Cross date | Select against |
| --- | --- | --- | --- | --- | --- |
| `CS x w1118` | Wild type control | F, M | Corn Meal | 18-Jun |  |
| `empty split > Kir2.1` | Silencing control | F | Corn Meal | 18-Jun | Curly, Humeral |
| `T4/T5 (SS00324) > Kir2.1` | Silencing experiment | F | Corn Meal | 18-Jun | Curly, Humeral |
| `empty split > CsChrimson` | Optogenetic activation control | F, M | 1:250 Retinal | 18-Jun | Curly, Humeral |
| `LC-6 (R_42E06) > CsChrimson` | Optogenetic activation | F, M | 1:250 Retinal | 18-Jun |  |
| `P1 (15A01;71G01) > CsChrimson` | Optogenetic activation | M | 1:250 Retinal | 18-Jun |  |
| `Hot Cell (HC-Gal4) > CsChrimson` | Optogenetic activation | F | 1:250 Retinal | 18-Jun |  |
| `pC1_19 (SS100895) > CsChrimson` | Optogenetic activation | M | 1:250 Retinal | 25-Jun |  |
| `pC1_17a,b (SS102696) > CsChrimson` | Optogenetic activation | M | 1:250 Retinal | 25-Jun | Curly |
| `MDN-1 (VT050660) > CsChrimson` | Moonwalker | F, M | 1:250 Retinal | 18-Jun | Humeral |
| `NP225 > CsChrimson` | Spins | F, M | 1:250 Retinal | 18-Jun | Bar (eye) |
| `LC-24 (SS02638) > CsChrimson` | Forward walking | F, M | 1:250 Retinal | 18-Jun |  |
| `Avoidance (SS01159) > CsChrimson` | Avoidance | F, M | 1:250 Retinal | 18-Jun | Humeral |
| `Giant Fiber (17A04-AD;68A06-DBD) > CsChrimson` | Giant fiber | F, M | 1:250 Retinal | 18-Jun |  |
| `none` | No fly / hardware test / metadata placeholder | N/A | N/A |  |

## Selecting flies: markers to avoid

The course repository's [current genotype YAML](https://github.com/reiserlab/cshl-2026-course/blob/main/genotypes.yaml)
lists visible markers to **select against** for specific stocks. In other words,
choose flies that do **not** show the marker(s) in this table. The repository is
private, so open this link while signed in with the course GitHub account.

| Course line | Select against | Practical reading rule |
| --- | --- | --- |
| `empty split > Kir2.1` | Curly, Humeral | Use flies without Curly wings or Humeral. |
| `T4/T5 (SS00324) > Kir2.1` | Curly, Humeral | Use flies without Curly wings or Humeral. |
| `empty split > CsChrimson` | Curly, Humeral | Use flies without Curly wings or Humeral. |
| `pC1_17a,b (SS102696) > CsChrimson` | Curly | Use flies without Curly wings. |
| `MDN-1 (VT050660) > CsChrimson` | Humeral | Use flies without Humeral. |
| `NP225 > CsChrimson` | Bar (eye) | Use flies without the Bar-eye marker. |
| `Avoidance (SS01159) > CsChrimson` | Humeral | Use flies without Humeral. |

## Full Genotype Reference

References are ordered with the foundational driver or cell-type paper first,
followed by a later exact driver-effector match when it adds useful confirmation.

### `CS x w1118`

- Wild type control.
- Source list name: `CS X w1118`
- Driver: N/A
- Effector: N/A
- Full genotype fields in the source YAML: blank
- Sexes: F, M

### `empty split > Kir2.1`

- Silencing control.
- Source list name: `None`
- Driver: `empty split GAL4`
- Effector: `Kir2.1`
- Full driver genotype: `pBPp65ADZp (attP40) ;pBPZpGAL4DBD`
- Full effector genotype: `w+ (DL); +(DL); pJFRC49-10XUAS- eGFPKir2.1(attP2)`
- Sexes: F
- Foundational control-driver reference: [Hampel et al. (2015), *A neural command circuit for grooming movement control*](https://doi.org/10.7554/eLife.08758) is the original paper associated with this enhancerless split-GAL4 control. No cell-type phenotype is expected from this control.
- Exact control configuration: [Keleş, Mongeau & Frye (2019), *Object features and T4/T5 motion detectors modulate the dynamics of bar tracking by Drosophila*](https://doi.org/10.1242/jeb.190017) later uses the enhancerless `pBPp65ADZp; pBPZpGAL4DBD > eGFP-Kir2.1` cross directly.

### `T4/T5 (SS00324) > Kir2.1`

- Silencing experiment.
- Source list name: `T4/T5`
- Driver: `SS00324`
- Effector: `Kir2.1`
- Full driver genotype: `59E08-p65ADZp(attP40); 42F06-PZpGdbd(attP2)`
- Full effector genotype: `w+ (DL); +(DL); pJFRC49-10XUAS- eGFPKir2.1(attP2)`
- Sexes: F
- Foundational driver reference: [Strother et al. (2017), *The Emergence of Directional Selectivity in the Visual Motion Pathway of Drosophila*](https://doi.org/10.1016/j.neuron.2017.03.010) uses the `R59E08-AD; R42F06-DBD` split driver to target T4/T5 and establishes that ON-pathway direction selectivity emerges in T4 dendrites.
- Exact driver + effector confirmation: [Keleş, Mongeau & Frye (2019), *Object features and T4/T5 motion detectors modulate the dynamics of bar tracking by Drosophila*](https://doi.org/10.1242/jeb.190017) later uses `SS00324 > eGFP-Kir2.1`; silencing removes the phase-advanced, co-directional steering component of bar tracking while leaving much of the orientation response intact.

### `empty split > CsChrimson`

- Optogenetic activation control.
- Source list name: `None`
- Driver: `empty split GAL4`
- Effector: `CsChrimson`
- Full driver genotype: `pBPp65ADZp (attP40) ;pBPZpGAL4DBD`
- Full effector genotype: `w+,20XUAS-CsChrimson-mVenus(attP18);;`
- Sexes: F, M
- Foundational control-driver reference: [Hampel et al. (2015), *A neural command circuit for grooming movement control*](https://doi.org/10.7554/eLife.08758) is the original paper associated with this enhancerless split-GAL4 control. No cell-type activation phenotype is expected from this control.
- Driver + effector-class confirmation: [Cheng, Colbath & Frye (2019), *Olfactory and Neuromodulatory Signals Reverse Visual Object Avoidance to Approach in Drosophila*](https://doi.org/10.1016/j.cub.2019.05.010) directly uses `pBPp65ADZp; pBPZpGAL4DBD > UAS-Chrimson` as the genetic control in flight-steering experiments; its Chrimson reporter has a different tag and insertion site from the course effector.

### `LC-6 (R_42E06) > CsChrimson`

- Optogenetic activation.
- Source list name: `LC-6`
- Driver: `R_42E06`
- Effector: `CsChrimson`
- Full driver genotype: `GMR42E06-Gal4(attP2)`
- Full effector genotype: `w+,20XUAS-CsChrimson-mVenus(attP18);;`
- Sexes: F, M
- Foundational cell-type phenotype: [Wu et al. (2016), *Visual projection neurons in the Drosophila lobula link feature detection to distinct behavioral programs*](https://doi.org/10.7554/eLife.21022) finds that LC6-specific split-GAL4 activation with CsChrimson produces high-penetrance jumping; this supports the LC6 assignment and expected phenotype, although it is not the same broad `R42E06-GAL4` driver.
- Exact driver + effector confirmation: [Vilinsky et al. (2018), *Probing Synaptic Transmission and Behavior in Drosophila with Optogenetics: A Laboratory Exercise*](https://pmc.ncbi.nlm.nih.gov/articles/PMC6153003/) tests `R42E06-GAL4 > 20XUAS-CsChrimson-mVenus` as the “Jumping” line and reports red-light-evoked jumping/startle behavior.

### `P1 (15A01;71G01) > CsChrimson`

- Optogenetic activation.
- Source list name: `P1`
- Driver: `15A01;71G01`
- Effector: `CsChrimson`
- Full driver genotype: `15A01-p65ADZp(attP40);71G01-ZpGdbd(attP2)`
- Full effector genotype: `w+,20XUAS-CsChrimson-mVenus(attP18);;`
- Sexes: M
- Foundational exact-driver reference: [Hoopfer et al. (2015), *P1 interneurons promote a persistent internal state that enhances inter-male aggression in Drosophila*](https://doi.org/10.7554/eLife.11346) defines the `R15A01-AD; R71G01-DBD` P1a split driver and shows intensity-dependent aggression and wing extension using thermogenetic and red-light optogenetic activation.
- Exact driver + CsChrimson confirmation: [Clemens et al. (2018), *Discovery of a New Song Mode in Drosophila Reveals Hidden Structure in the Sensory and Neural Drivers of Behavior*](https://doi.org/10.1016/j.cub.2018.06.011) uses `UAS-CsChrimson; R15A01-AD; R71G01-DBD` and shows that P1a activation promotes courtship song.

### `Hot Cell (HC-Gal4) > CsChrimson`

- Optogenetic activation.
- Source list name: `Hot Cell`
- Driver: `HC-Gal4`
- Effector: `CsChrimson`
- Full driver genotype: `HC-Gal4`
- Full effector genotype: `w+,20XUAS-CsChrimson-mVenus(attP18);;`
- Sexes: F
- Foundational exact-driver characterization: [Gallio et al. (2011), *The coding of temperature in the Drosophila brain*](https://doi.org/10.1016/j.cell.2011.01.028) shows that `HC-Gal4` labels the three aristal hot receptor neurons, characterizes their warming responses and projections, and shows that their silencing disrupts heat avoidance.
- Early exact-driver functional evidence: [Ni et al. (2013), *A gustatory receptor paralogue controls rapid warmth avoidance in Drosophila*](https://doi.org/10.1038/nature12390) uses `HC-Gal4` to show that hot-cell output is required for rapid negative thermotaxis and that restoring Gr28b(D) in these cells rescues the response.
- Exact driver + effector confirmation: [Huda et al. (2022), *Responses of different Drosophila species to temperature changes*](https://pmc.ncbi.nlm.nih.gov/articles/PMC9234498/) tests `HC-Gal4 > UAS-CsChrimson` directly and finds retinal-dependent avoidance of the illuminated area.

### `pC1_19 (SS100895) > CsChrimson`

- Optogenetic activation.
- Source list name: `pC1_19`
- Driver: `SS100895`
- Effector: `CsChrimson`
- Full driver genotype: `SS100895`
- Full effector genotype: `w+,20XUAS-CsChrimson-mVenus(attP18);;`
- Sexes: M
- Exact driver + effector (preprint): [Rubin et al. (2025), *Networks of sexually dimorphic neurons that regulate social behaviors in Drosophila*](https://doi.org/10.1101/2025.10.21.683766) maps `SS100895` to P1_19 (the paper's nomenclature) and reports that `SS100895 > 20XUAS-CsChrimson-mVenus` evokes sine song during illumination.

### `pC1_17a,b (SS102696) > CsChrimson`

- Optogenetic activation.
- Source list name: `pC1_17a,b`
- Driver: `SS102696`
- Effector: `CsChrimson`
- Full driver genotype: `SS102696`
- Full effector genotype: `w+,20XUAS-CsChrimson-mVenus(attP18);;`
- Sexes: M
- Exact driver + effector (preprint): [Rubin et al. (2025), *Networks of sexually dimorphic neurons that regulate social behaviors in Drosophila*](https://doi.org/10.1101/2025.10.21.683766) maps `SS102696` to P1_17a and P1_17b (the paper's nomenclature) and reports that `SS102696 > 20XUAS-CsChrimson-mVenus` evokes a transient pulse-song response at light onset.

### `MDN-1 (VT050660) > CsChrimson`

- Moonwalker.
- Source list note: `Moonwalker`
- Driver: `VT050660-Gal4`
- Effector: `CsChrimson`
- Full driver genotype: `VT050660-Gal4`
- Full effector genotype: `20XUAS-CsChrimson-mVenus(attP18);;`
- Sexes: F, M
- Exact-driver activation: [Bidaye et al. (2014), *Neuronal control of Drosophila walking direction*](https://doi.org/10.1126/science.1249964) uses `VT050660-GAL4` activation to identify moonwalker descending neurons and induce backward walking. This broad driver is less MDN-specific than the later split-GAL4 lines.
- Exact driver + effector: [Vilinsky et al. (2018), *Probing Synaptic Transmission and Behavior in Drosophila with Optogenetics: A Laboratory Exercise*](https://pmc.ncbi.nlm.nih.gov/articles/PMC6153003/) tests `VT050660-GAL4 > 20XUAS-CsChrimson-mVenus` as the “Moonwalker” line and reports red-light-evoked backward walking.

### `NP225 > CsChrimson`

- Spins.
- Source list note: `Spins`
- Driver: `NP225`
- Effector: `CsChrimson`
- Full driver genotype: `NP225`
- Full effector genotype: `10XUAS-Chrimson88-tdT`
- Sexes: F, M
- Exact driver + effector: [Aso et al. (2014), *Mushroom body output neurons encode valence and guide memory-based action selection in Drosophila*](https://doi.org/10.7554/eLife.04580) reports that `NP225-GAL4 > CsChrimson` flies back away from an illuminated region and, when already illuminated, show continuous rotation that typically lasts for the full 30-s light period. “Spins” is course shorthand for that rotation; the paper's primary interpretation is retreat/backward walking from broad projection-neuron activation.

### `LC-24 (SS02638) > CsChrimson`

- Forward walking.
- Source list note: `Forward Walking`
- Driver: `SS02638`
- Effector: `CsChrimson`
- Full driver genotype: `SS02638`
- Full effector genotype: `20XUAS-CsChrimson-mVenus(attP18);;`
- Sexes: F, M
- Exact driver + effector: [Wu et al. (2016), *Visual projection neurons in the Drosophila lobula link feature detection to distinct behavioral programs*](https://doi.org/10.7554/eLife.21022) identifies `SS02638` as LC24 and reports a forward-walking phenotype during CsChrimson activation, especially in the arena assay.

### `Avoidance (SS01159) > CsChrimson`

- Avoidance.
- Source list note: `Avoidance`
- Driver: `SS01159`
- Effector: `CsChrimson`
- Full driver genotype: `SS01159`
- Full effector genotype: `20XUAS-CsChrimson-mVenus(attP18);;`
- Sexes: F, M
- Exact driver + effector: [Shuai et al. (2025), *Driver lines for studying associative learning in Drosophila*](https://doi.org/10.7554/eLife.94168) reports robust avoidance of illuminated quadrants in `SS01159 > CsChrimson` flies, together with increased movement and turning at the light boundary.

### `Giant Fiber (17A04-AD;68A06-DBD) > CsChrimson`

- Giant fiber.
- Source list note: `Giant Fiber`
- Driver: `17A04-AD;68A06-DBD`
- Effector: `CsChrimson`
- Full driver genotype: `17A04-AD;68A06-DBD`
- Full effector genotype: `20XUAS-CsChrimson-mVenus(attP18);;`
- Sexes: F, M
- Exact-driver characterization: [von Reyn et al. (2014), *A spike-timing mechanism for action selection*](https://doi.org/10.1038/nn.3741) uses the `R17A04-AD;R68A06-DBD` split driver to isolate the giant-fiber pair and relates giant-fiber timing to the selection of short versus long takeoff sequences.
- Exact driver + effector: [Gaitanidis et al. (2025), *The Drosophila escape motor circuit shows differential vulnerability to aging linked to functional decay*](https://doi.org/10.1371/journal.pbio.3003553) expresses UAS-CsChrimson with this exact giant-fiber split driver and shows that a 50-ms red-light flash reliably evokes escape.

## Notes for metadata entry

- Use the line shorthand exactly when possible.
- Record sex separately. Several lines are sex-specific for the planned experiments.
- Use `none` only for no-fly hardware tests, bridge tests, or placeholder metadata.
- If a course run uses a genotype not listed here, ask an instructor what
  shorthand name to use before repeated runs.
