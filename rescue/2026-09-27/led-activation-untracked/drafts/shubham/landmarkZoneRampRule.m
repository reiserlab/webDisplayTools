function rule = landmarkZoneRampRule(voltage, safeStart_deg, safeSpan_deg, rampDeg, logDir, label, startOffsetDeg, opts)
% landmarkZoneRampRule  Place-learning heat rule with a SLOPED zone edge and
%                       NO per-transition DAQ task start/stop.
%
% Drop-in replacement for landmarkZoneContinuousLogRule (same positional
% arguments except pulseHz/dutyCycle are gone and rampDeg is added):
%
%   rule = landmarkZoneRampRule(OPTO_VOLTAGE, safeStart_deg, SAFE_SPAN_DEG, 15, ...
%                               exp.logDir, boutName, offset);
%
% WHAT CHANGED AND WHY (P057_L2A_20260917 analysis, 2026-09-18)
%   The buffered 1 kHz pulse (startPulseContinuous / stopPulse) blocked the
%   FicTrac loop for a median 64 ms on every zone entry and 34 ms on every
%   exit: 274 of the 296 >25 ms loop gaps in that session sat on the row
%   right after an opto transition, the pattern froze for 4-16 FicTrac
%   frames and then jumped by up to 16 columns (30 deg) - exactly at
%   punishment onset. FicTrac itself never dropped a frame (9.83 ms period
%   throughout). This rule drives the LED with ONE outputSingleScan per
%   level change (~1 ms on the MCC USB-1208FS), the way Florence's rig did
%   (one AO write per frame, zero measured lag).
%
%   Consequence: the LED is DC, not 1 kHz/50 %. Re-run the p022/p028
%   calibration to find the DC voltage that gives the SAME mean irradiance
%   as OPTO_VOLTAGE at 50 % duty (do not assume half the voltage - the
%   driver may be non-linear near threshold). Pass that value as `voltage`.
%
% SLOPED EDGE
%   level(patternDeg) is 0 inside the flat safe zone, rises to 1 over
%   rampDeg on each side, and is 1 everywhere else. The zone as a whole is
%   therefore safeSpan_deg + 2*rampDeg wide at the outer foot of the ramps
%   (90 + 2*15 = 120 deg - the same outer width Florence's smoothed map had).
%   Ramp shape: opts.rampShape = 'linear' (default) or 'florence'
%   (his measured 0 -> 17/37/53/68/78/87/91/96/98/100 % over 15 deg, i.e.
%   front-loaded). The table is precomputed per column (192 x 1), so the
%   per-frame cost is one lookup + at most one AO write.
%
%   safeSpan_deg = 0 -> uniform heat (preprobe / probe), as before.
%
% OPTIONAL
%   opts.minDwellS  (default 0)  minimum time between level changes in the
%                   ramp region; 0.1-0.2 s tames edge chatter without a
%                   deadband. Florence had none; P057 showed 166 of 292
%                   transitions < 0.5 s apart.
%   opts.quantV     (default 0.001) round commanded voltage to this step so
%                   sub-LSB changes do not trigger writes (1208FS LSB = 1 mV).
%
% LOG  closedloop.csv (one per session, same persistent-handle pattern):
%   timestamp_s,trial_name,trial_time_s,frame_counter,heading_abs_rad,
%   heading_delta_deg,pattern_col,pattern_deg,stripe_section,in_safe,
%   level,voltage_V,safe_start_deg,safe_end_deg,ramp_deg,start_offset_deg
%   `in_safe` = 1 only in the flat (level 0) part; `level` is the 0-1 ramp
%   value so the analysis can reconstruct the exact heat profile.
%
% See also landmarkZoneContinuousLogRule, OptoStim.setVoltage.

    arguments
        voltage        (1,1) double
        safeStart_deg  (1,1) double = 0
        safeSpan_deg   (1,1) double = 90
        rampDeg        (1,1) double = 15
        logDir         string       = ""
        label          string       = ""
        startOffsetDeg (1,1) double = 0
        opts.rampShape string {mustBeMember(opts.rampShape, ["linear","florence"])} = "linear"
        opts.minDwellS (1,1) double = 0
        opts.quantV    (1,1) double = 0.001
    end

    N_FRAMES      = 192;
    DEG_PER_FRAME = 360 / N_FRAMES;
    SECTION_WIDTH = 120;

    % ---- precomputed level table, one entry per pattern column -------------
    levelByCol = buildLevelTable(N_FRAMES, DEG_PER_FRAME, safeStart_deg, safeSpan_deg, rampDeg, opts.rampShape);
    safeEnd_deg = safeStart_deg + safeSpan_deg;
    startOffsetRad = deg2rad(startOffsetDeg);

    % ---- shared log handle (one file per session) --------------------------
    persistent sharedFid sharedPath
    if isempty(sharedFid); sharedFid = -1; end

    % ---- state --------------------------------------------------------------
    baseline  = [];
    lastV     = NaN;      % last voltage actually written
    lastVTime = -Inf;
    t0Posix   = 0;
    t0Tic     = [];

    rule.reset = @resetFn;
    rule.apply = @applyFn;
    rule.close = @closeFn;
    rule.levelByCol = levelByCol;   % exposed for plotting / unit checks

    function closeFn()
        if sharedFid ~= -1 && ~isempty(fopen(sharedFid)); fclose(sharedFid); end
        sharedFid = -1; sharedPath = "";
    end

    function resetFn()
        baseline  = [];
        lastV     = NaN;
        lastVTime = -Inf;
        t0Posix   = posixtime(datetime('now', 'TimeZone', 'local'));
        t0Tic     = tic;
        if strlength(logDir) == 0; return; end
        if ~isfolder(logDir); mkdir(logDir); end
        wantPath = fullfile(logDir, 'closedloop.csv');
        if sharedFid ~= -1
            if isempty(fopen(sharedFid)); sharedFid = -1;
            elseif ~strcmp(sharedPath, wantPath); fclose(sharedFid); sharedFid = -1; end
        end
        if sharedFid == -1
            isNew = ~isfile(wantPath) || (dir(wantPath).bytes == 0);
            sharedFid = fopen(wantPath, 'a');
            if sharedFid == -1
                warning('landmarkZoneRampRule: cannot open %s', wantPath); return;
            end
            sharedPath = wantPath;
            if isNew
                fprintf(sharedFid, ['timestamp_s,trial_name,trial_time_s,frame_counter,' ...
                    'heading_abs_rad,heading_delta_deg,pattern_col,pattern_deg,stripe_section,' ...
                    'in_safe,level,voltage_V,safe_start_deg,safe_end_deg,ramp_deg,start_offset_deg\n']);
            end
            fprintf('landmarkZoneRampRule: logging all trials to %s\n', wantPath);
        end
    end

    function applyFn(frame, opto, arena)
        if isempty(baseline)
            baseline = frame;
            baseline.intHeading = frame.intHeading - startOffsetRad;
        end
        t = toc(t0Tic);

        % --- heading -> pattern column (unchanged) ---------------------------
        deltaDeg      = mod(rad2deg(frame.intHeading - baseline.intHeading), 360);
        patternCol    = mod(round(deltaDeg / DEG_PER_FRAME), N_FRAMES) + 1;
        stripeSection = min(floor(deltaDeg / SECTION_WIDTH), 2);
        arena.streamPattern(patternCol);

        % --- heat level from the table; write the AO only when it changes ----
        level = levelByCol(patternCol);
        v     = round(voltage * level / opts.quantV) * opts.quantV;
        if v ~= lastV
            inRamp = level > 0 && level < 1;
            if ~inRamp || (t - lastVTime) >= opts.minDwellS
                opto.setVoltage(v, frame.frameCounter);   % ~1 ms outputSingleScan
                lastV = v; lastVTime = t;
            else
                v = lastV;                                 % dwell: keep the last level
            end
        end

        % --- per-frame log -----------------------------------------------------
        if sharedFid ~= -1
            fprintf(sharedFid, '%.6f,%s,%.4f,%d,%.8f,%.4f,%d,%.4f,%d,%d,%.3f,%.4f,%d,%.4f,%g,%d\n', ...
                t0Posix + t, label, t, frame.frameCounter, frame.intHeading, deltaDeg, ...
                patternCol, deltaDeg, stripeSection, int32(level == 0), level, v, ...
                safeStart_deg, safeEnd_deg, rampDeg, startOffsetDeg);
        end
    end
end

function lv = buildLevelTable(nFrames, degPerFrame, safeStart_deg, safeSpan_deg, rampDeg, shape)
% Level (0 = LED off, 1 = full) for the CENTRE of each pattern column.
% Distance is measured from the nearest flat-zone edge, outward.
    lv = ones(nFrames, 1);
    if safeSpan_deg <= 0; return; end                    % uniform heat (probe)
    centre = mod(safeStart_deg + safeSpan_deg / 2, 360);
    half   = safeSpan_deg / 2;
    % Florence's measured ramp (fraction of full drive vs deg past the
    % LED-off edge), from run_az_PL_experiment.m power_vec after gausswin(15)
    % smoothing, clipped at 0 V: 0 at 0 deg, 39 % at 3.0, 70 % at 6.8,
    % 88 % at 10.5, 96 % at 14.3, 100 % at 18 deg.
    flDeg = [0 3.0 6.8 10.5 14.3 18.0];
    flLev = [0 0.39 0.70 0.88 0.96 1.00];
    for k = 1:nFrames
        colCentreDeg = (k - 1) * degPerFrame;
        d = abs(mod(colCentreDeg - centre + 180, 360) - 180);   % |angle from zone centre|
        past = d - half;                                        % deg outside the flat zone
        if past <= 0
            lv(k) = 0;
        elseif rampDeg <= 0 || past >= rampDeg
            lv(k) = 1;
        elseif shape == "florence"
            lv(k) = interp1(flDeg * (rampDeg / 15), flLev, past, 'linear', 1);
        else
            lv(k) = past / rampDeg;
        end
    end
end
