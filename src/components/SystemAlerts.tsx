import { useEffect, useState } from 'react';
import { ipcRenderer } from 'electron';
import { useNavigate } from 'react-router-dom';
import { Alert } from '@mui/material';
import { log } from '../helpers/log';
import { countPendingDrafts, pendingDraftsMessage } from './pendingDrafts.ts';

export interface AlertContent {
    severity: 'error' | 'warning' | 'info' | 'success';
    message: string;
}

export const SystemAlerts = () => {
    const [alertContent, setAlertContent] = useState<AlertContent | null>(null);

    const navigate = useNavigate();

    const alertClose = () => {
        setAlertContent(null);
    };

    // respond to the user selecting Reset Database from the menu
    useEffect(() => {
        ipcRenderer.on('init-refresh-database', async () => {
            countPendingDrafts(ipcRenderer)
                .then((unSyncData) => {
                    if (unSyncData > 0) {
                        setAlertContent({
                            severity: 'error',
                            message: pendingDraftsMessage(unSyncData),
                        });
                    } else {
                        setAlertContent({
                            severity: 'success',
                            message: `Database will refresh shortly. You will be automatically logged out.
                            Please login again and sync first.
                            It might take a while for the first sync. please be patient while syncing`,
                        });

                        ipcRenderer.invoke('refresh-database').then(() => {
                            navigate('/');
                            setAlertContent(null);
                        });
                    }
                })
                .catch((error) => {
                    // Never fall through to the wipe: an unreadable draft count is not a zero count.
                    log.error(`Error counting unsynced drafts: ${error}`);
                    setAlertContent({
                        severity: 'error',
                        message: 'Could not check for unsynced data, so the database was not reset. Please try again.',
                    });
                });
        });
    }, [navigate]);

    return (
        <>
            {alertContent && (
                <Alert severity={alertContent.severity} onClose={alertClose}>
                    {alertContent.message}
                </Alert>
            )}
        </>
    );
};
