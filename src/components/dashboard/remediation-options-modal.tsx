import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";

type RemediationOption = {
  id: string;
  name: string;
  description: string;
  steps: string[];
  cost: {
    downtime: string;
    downtime_seconds: number;
    resource_impact: string;
    risk_level: string;
    execution_time: string;
    llm_analysis_usd?: number;
  };
  pros: string[];
  cons: string[];
  confidence: number;
};

type OptionsModalProps = {
  isOpen: boolean;
  options: RemediationOption[];
  selectedOption: string;
  selectionReason: string;
  onClose: () => void;
  onSelectOption: (optionId: string) => void;
  onStartHealing: () => void;
  isLoading?: boolean;
};

export function RemediationOptionsModal({
  isOpen,
  options,
  selectedOption,
  selectionReason,
  onClose,
  onSelectOption,
  onStartHealing,
  isLoading = false,
}: OptionsModalProps) {
  const [displayedOption, setDisplayedOption] = useState(0);

  const formatUsd = (value?: number) => {
    if (typeof value !== "number" || Number.isNaN(value) || value <= 0) {
      return "N/A";
    }
    return `$${value.toFixed(6)}`;
  };

  useEffect(() => {
    if (!isOpen) {
      setDisplayedOption(0);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const selectedIdx = options.findIndex((opt) => opt.id === selectedOption);

  const getRiskBadge = (level: string) => {
    if (level.toLowerCase() === "low")
      return "inline-block rounded bg-[#e8f5e8] px-2 py-1 text-xs font-semibold text-ok";
    if (level.toLowerCase() === "medium")
      return "inline-block rounded bg-[#fff8e8] px-2 py-1 text-xs font-semibold text-accent";
    if (level.toLowerCase() === "high")
      return "inline-block rounded bg-[#ffe8e8] px-2 py-1 text-xs font-semibold text-danger";
    return "inline-block rounded bg-[#f0e8e0] px-2 py-1 text-xs font-semibold text-[#4f5d68]";
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="relative w-full max-w-2xl rounded-lg bg-white p-6 shadow-2xl">
        {/* Header */}
        <div className="mb-6">
          <div className="text-2xl font-bold text-[#1f2b33]">Remediation Options Analysis</div>
          <div className="mt-2 text-sm text-[#4f5d68]">
            Evaluating {options.length} remediation strategies...
            {isLoading && <span className="ml-2 animate-pulse">Processing</span>}
          </div>
        </div>

        {/* Options Carousel */}
        <div className="mb-6 space-y-4">
          <div className="flex gap-2">
            {options.map((opt, idx) => (
              <button
                key={opt.id}
                onClick={() => {
                  setDisplayedOption(idx);
                  onSelectOption(opt.id);
                }}
                className={cn(
                  "px-4 py-2 text-sm font-semibold rounded transition",
                  displayedOption === idx
                    ? "bg-[#1f2b33] text-white"
                    : "border border-[#d9c7b8] bg-[#f5f0e8] text-[#4f5d68] hover:bg-[#ece5da]"
                )}
              >
                {opt.name}
                {selectedOption === opt.id && " ✓"}
              </button>
            ))}
          </div>

          {/* Current Option Display */}
          <div className="rounded-lg border border-[#e3d7cc] bg-[#faf7f3] p-6">
            <div className="mb-4">
              <div className="text-xl font-bold text-[#1f2b33]">{options[displayedOption]?.name}</div>
              <div className="mt-2 text-sm text-[#4f5d68]">{options[displayedOption]?.description}</div>
            </div>

            {/* Cost Grid */}
            <div className="mb-6 grid gap-3 md:grid-cols-2">
              <div className="rounded-lg bg-white p-4">
                <div className="text-xs font-semibold text-muted">Impact & Risk</div>
                <div className="mt-3 space-y-2">
                  <div>
                    <div className="text-xs text-muted">Downtime</div>
                    <div className="text-sm font-semibold text-[#1f2b33]">
                      {options[displayedOption]?.cost.downtime}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-muted">Resource Impact</div>
                    <div className="text-sm font-semibold text-[#1f2b33]">
                      {options[displayedOption]?.cost.resource_impact}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-muted">LLM analysis cost</div>
                    <div className="text-sm font-semibold text-[#1f2b33]">
                      {formatUsd(options[displayedOption]?.cost.llm_analysis_usd)}
                    </div>
                  </div>
                  <div className="pt-2">
                    <div className="text-xs text-muted">Risk Level</div>
                    <div className={getRiskBadge(options[displayedOption]?.cost.risk_level || "")}>
                      {options[displayedOption]?.cost.risk_level}
                    </div>
                  </div>
                </div>
              </div>

              <div className="rounded-lg bg-white p-4">
                <div className="text-xs font-semibold text-muted">Advantages</div>
                <ul className="mt-3 space-y-2">
                  {options[displayedOption]?.pros.slice(0, 2).map((pro, i) => (
                    <li key={i} className="flex gap-2 text-xs text-ok">
                      <span className="font-bold">✓</span>
                      <span>{pro}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            {/* Selection Indicator */}
            {selectedOption === options[displayedOption]?.id && (
              <div className="rounded-lg border border-[#b8d4a8] bg-[#f2fce8] p-4">
                <div className="font-semibold text-[#3d4e2c]">✓ This option was selected</div>
                <div className="mt-2 text-sm text-[#3d4e2c]">
                  <strong>Reason:</strong> {selectionReason}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Close Button */}
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-md border border-[#d9c7b8] bg-[#f5f0e8] px-4 py-2 text-sm font-semibold text-[#4f5d68] hover:bg-[#ece5da]"
          >
            Close
          </button>
          <button
            onClick={onStartHealing}
            disabled={isLoading || !selectedOption}
            className="rounded-md border border-[#b8d4a8] bg-[#e8f5e8] px-4 py-2 text-sm font-semibold text-[#2f5f3a] hover:bg-[#dff0df] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isLoading ? "Starting..." : "Start Healing with Selected"}
          </button>
          {selectedIdx >= 0 && (
            <div className="flex items-center gap-2 rounded-md bg-[#e8f5e8] px-4 py-2 text-sm font-semibold text-ok">
              <span className="text-lg">✓</span>
              Selected: {options[selectedIdx].name}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
