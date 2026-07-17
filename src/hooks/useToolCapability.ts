import { useCallback, useEffect, useState } from 'react';
import { novaClient } from '../api/novaClient';

export interface CapabilityCheck {
  available: boolean;
  toolId: string;
  requiresMessage: string;
  loading: boolean;
}

export function useToolCapability(capabilityId: string): CapabilityCheck {
  const [state, setState] = useState<CapabilityCheck>({
    available: false,
    toolId: '',
    requiresMessage: '',
    loading: true,
  });

  const check = useCallback(async () => {
    try {
      const result = await novaClient.checkToolCapability(capabilityId);
      setState({
        available: result.available,
        toolId: result.toolId,
        requiresMessage: result.requiresMessage || '',
        loading: false,
      });
    } catch {
      setState({
        available: false,
        toolId: '',
        requiresMessage: `Failed to check capability: ${capabilityId}`,
        loading: false,
      });
    }
  }, [capabilityId]);

  useEffect(() => {
    check();
  }, [check]);

  return state;
}

export function useMultipleCapabilities(capabilityIds: string[]): Record<string, CapabilityCheck> {
  const [states, setStates] = useState<Record<string, CapabilityCheck>>({});

  useEffect(() => {
    const load = async () => {
      const results: Record<string, CapabilityCheck> = {};
      await Promise.all(
        capabilityIds.map(async (id) => {
          try {
            const result = await novaClient.checkToolCapability(id);
            results[id] = {
              available: result.available,
              toolId: result.toolId,
              requiresMessage: result.requiresMessage || '',
              loading: false,
            };
          } catch {
            results[id] = {
              available: false,
              toolId: '',
              requiresMessage: '',
              loading: false,
            };
          }
        }),
      );
      setStates(results);
    };
    load();
  }, [capabilityIds.join(',')]);

  return states;
}
