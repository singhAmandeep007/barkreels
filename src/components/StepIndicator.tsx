import { Camera, Sparkles, Mic, Film, Check } from 'lucide-react';

interface StepIndicatorProps {
  currentStep: number;
  completedSteps: number[];
}

const STEPS = [
  { id: 0, label: 'Upload Photo', icon: Camera },
  { id: 1, label: 'AI Analysis', icon: Sparkles },
  { id: 2, label: 'Voice', icon: Mic },
  { id: 3, label: 'Export', icon: Film },
];

export function StepIndicator({ currentStep, completedSteps }: StepIndicatorProps) {
  return (
    <div className="w-full max-w-3xl mx-auto mb-12 px-8">
      <div className="relative flex justify-between items-center">
        {/* Connecting Lines Background */}
        <div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-1 bg-gray-800 z-0 rounded-full" />
        
        {/* Active Progress Line */}
        <div 
          className="absolute left-0 top-1/2 -translate-y-1/2 h-1 bg-gradient-to-r from-amber-500 via-orange-500 to-rose-500 z-0 transition-all duration-500 rounded-full"
          style={{ width: `${(currentStep / (STEPS.length - 1)) * 100}%` }}
        />

        {/* Steps */}
        {STEPS.map((step) => {
          const isCompleted = completedSteps.includes(step.id);
          const isCurrent = currentStep === step.id;
          const Icon = step.icon;

          return (
            <div key={step.id} className="relative z-10 flex flex-col items-center">
              <div 
                className={`w-12 h-12 rounded-full flex items-center justify-center transition-all duration-300 border-2 ${
                  isCompleted
                    ? 'bg-gradient-to-br from-amber-500 to-rose-500 border-transparent text-white shadow-lg shadow-amber-500/20'
                    : isCurrent
                      ? 'bg-gray-900 border-amber-500 text-amber-500 shadow-[0_0_20px_rgba(245,158,11,0.2)]'
                      : 'bg-gray-950 border-gray-800 text-gray-500'
                }`}
              >
                {isCompleted ? (
                  <Check className="h-5 w-5" />
                ) : (
                  <Icon className={`h-5 w-5 ${isCurrent ? 'animate-pulse' : ''}`} />
                )}
              </div>
              <div 
                className={`absolute -bottom-7 left-1/2 -translate-x-1/2 w-max text-xs font-medium transition-colors duration-300 ${
                  isCurrent || isCompleted ? 'text-gray-200' : 'text-gray-600'
                }`}
              >
                {step.label}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
