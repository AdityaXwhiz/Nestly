import { createBrowserRouter, Navigate } from 'react-router-dom';
import { Layout } from '../components/layout/Layout.jsx';
import { BrowseProperties } from '../pages/BrowseProperties.jsx';
import { PropertyDetail } from '../pages/PropertyDetail.jsx';
import { BrowseServices } from '../pages/BrowseServices.jsx';
import { Login } from '../pages/Login.jsx';
import { Register } from '../pages/Register.jsx';
import { BookPlaceholder } from '../pages/BookPlaceholder.jsx';
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
      // Customer-only route (Change #9)
      {
        element: <RoleRoute allowedRoles={['CUSTOMER']} />,
        children: [
          {
            path: 'book/:id',
            element: <BookPlaceholder />,
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
