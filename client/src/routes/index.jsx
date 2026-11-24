import { createBrowserRouter, Navigate } from 'react-router-dom';
import { Layout } from '../components/layout/Layout.jsx';
import { BrowseProperties } from '../pages/BrowseProperties.jsx';
import { PropertyDetail } from '../pages/PropertyDetail.jsx';
import { BrowseServices } from '../pages/BrowseServices.jsx';
import { Login } from '../pages/Login.jsx';
import { Register } from '../pages/Register.jsx';
import { BookingStepper } from '../pages/BookStepper/BookingStepper.jsx';
import { OrderStatus } from '../pages/OrderStatus.jsx';
import { OrdersList } from '../pages/OrdersList.jsx';
import { HostProperties } from '../pages/HostProperties.jsx';
import { HostPropertyForm } from '../pages/HostPropertyForm.jsx';
import { ProviderServices } from '../pages/ProviderServices.jsx';
import { NotFound } from '../pages/NotFound.jsx';
import { GuestRoute, RoleRoute } from './Guards.jsx';
import { ErrorBoundary } from '../components/common/ErrorBoundary.jsx';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <Layout />,
    errorElement: (
      <Layout>
        <ErrorBoundary />
      </Layout>
    ),
    children: [
      {
        index: true,
        element: <Navigate to="/properties" replace />,
      },
      {
        path: 'properties',
        element: <BrowseProperties />,
      },
      {
        path: 'properties/:id',
        element: <PropertyDetail />,
      },
      {
        path: 'services',
        element: <BrowseServices />,
      },

      // Guest-only routes
      {
        element: <GuestRoute />,
        children: [
          {
            path: 'login',
            element: <Login />,
          },
          {
            path: 'register',
            element: <Register />,
          },
        ],
      },

      // Customer-only routes
      {
        element: <RoleRoute allowedRoles={['CUSTOMER']} />,
        children: [
          {
            path: 'book/:id',
            element: <BookingStepper />,
          },
        ],
      },

      // Orders (Customer or Admin)
      {
        element: <RoleRoute allowedRoles={['CUSTOMER', 'ADMIN']} />,
        children: [
          {
            path: 'orders',
            element: <OrdersList />,
          },
          {
            path: 'orders/:id',
            element: <OrderStatus />,
          },
        ],
      },

      // Host-only routes (Change #7: host forms are routes)
      {
        element: <RoleRoute allowedRoles={['HOST']} />,
        children: [
          {
            path: 'host/properties',
            element: <HostProperties />,
          },
          {
            path: 'host/properties/new',
            element: <HostPropertyForm />,
          },
          {
            path: 'host/properties/:id',
            element: <HostPropertyForm />,
          },
        ],
      },

      // Provider-only routes
      {
        element: <RoleRoute allowedRoles={['PROVIDER']} />,
        children: [
          {
            path: 'provider/services',
            element: <ProviderServices />,
          },
        ],
      },

      // Catch-all 404
      {
        path: '*',
        element: <NotFound />,
      },
    ],
  },
]);
